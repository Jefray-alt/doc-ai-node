import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import type { PutObjectCommand } from '@aws-sdk/client-s3';
import type { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import {
  readStorageConfig,
  createS3ClientConfig,
} from '../src/storage/config.ts';
import { createUploadSigner } from '../src/storage/signer.ts';

const backendRoot = new URL('../', import.meta.url);

async function startServer(storage: NodeJS.ProcessEnv) {
  const env = {
    ...process.env,
    PORT: '0',
  };

  for (const key of Object.keys(env)) {
    if (
      key.startsWith('AWS_')
      || key.startsWith('S3_')
      || key === 'STORAGE_MODE'
    ) {
      delete env[key];
    }
  }

  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: backendRoot,
    env: {
      ...env,
      ...storage,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let listening = false;

  child.stdout.on('data', (data) => {
    output += String(data);

    if (output.includes('API listening')) {
      listening = true;
      child.kill();
    }
  });

  child.stderr.on('data', (data) => {
    output += String(data);
  });

  const timeout = setTimeout(() => child.kill(), 5000);

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });

  clearTimeout(timeout);

  return {
    code,
    output,
    listening,
  };
}

test('missing storage mode prevents startup before opening the listener', async () => {
  const result = await startServer({});

  assert.equal(
    result.listening,
    false,
    'server must refuse to listen without STORAGE_MODE',
  );
  assert.equal(result.code, 1);
  assert.match(result.output, /STORAGE_MODE/);
});

test('a non-loopback Moto endpoint prevents startup', async () => {
  const result = await startServer({
    STORAGE_MODE: 'moto',
    AWS_REGION: 'us-east-1',
    S3_STAGING_BUCKET: 'pdf-staging',
    S3_ENDPOINT: 'https://s3.amazonaws.com',
  });

  assert.equal(
    result.listening,
    false,
    'server must refuse a remote Moto endpoint',
  );
  assert.equal(result.code, 1);
  assert.match(result.output, /S3_ENDPOINT/);
});

const motoEnv = {
  STORAGE_MODE: 'moto',
  AWS_REGION: 'us-east-1',
  S3_STAGING_BUCKET: 'pdf-staging',
  S3_ENDPOINT: 'http://localhost:5000',
};

const awsEnv = {
  STORAGE_MODE: 'aws',
  AWS_REGION: 'ap-southeast-1',
  S3_STAGING_BUCKET: 'deployed-staging',
};

test('Moto requires explicit valid mode, region, bucket and endpoint', () => {
  assert.deepEqual(readStorageConfig(motoEnv), {
    mode: 'moto',
    region: 'us-east-1',
    stagingBucket: 'pdf-staging',
    endpoint: 'http://localhost:5000',
  });

  for (const key of Object.keys(motoEnv)) {
    for (const value of [undefined, '', ' ']) {
      assert.throws(
        () => readStorageConfig({
          ...motoEnv,
          [key]: value,
        }),
        undefined,
        `${key}: ${value}`,
      );
    }
  }

  assert.throws(
    () => readStorageConfig({
      ...motoEnv,
      STORAGE_MODE: 'auto',
    }),
    /STORAGE_MODE/,
  );

  assert.throws(
    () => readStorageConfig({
      ...motoEnv,
      AWS_REGION: 'not a region',
    }),
    /AWS_REGION/,
  );

  for (const bucket of [
    'a',
    'UPPER',
    'bad/name',
    'bad..name',
    'bad.-name',
    '127.0.0.1',
    'x'.repeat(64),
  ]) {
    assert.throws(
      () => readStorageConfig({
        ...motoEnv,
        S3_STAGING_BUCKET: bucket,
      }),
      /S3_STAGING_BUCKET/,
    );
  }
});

test('Moto accepts browser loopback origins and rejects nonlocal or decorated URLs', () => {
  for (const endpoint of [
    'http://localhost:5000',
    'http://127.0.0.1:5000/',
    'http://[::1]:5000',
  ]) {
    const config = readStorageConfig({
      ...motoEnv,
      S3_ENDPOINT: endpoint,
    });

    assert.equal(config.mode, 'moto');
  }

  for (const endpoint of [
    'invalid',
    'https://s3.amazonaws.com',
    'http://moto:5000',
    'http://0.0.0.0:5000',
    'http://localhost.evil:5000',
    'http://127.0.0.1.evil:5000',
    'ftp://localhost:5000',
    'http://user:secret@localhost:5000',
    'http://localhost:5000/bucket',
    'http://localhost:5000?redirect=aws',
    'http://localhost:5000#fragment',
  ]) {
    assert.throws(
      () => readStorageConfig({
        ...motoEnv,
        S3_ENDPOINT: endpoint,
      }),
      /S3_ENDPOINT/,
      endpoint,
    );
  }
});

test('AWS mode has no local overrides and keeps default deployment credential resolution', () => {
  const config = readStorageConfig(awsEnv);

  assert.deepEqual(config, {
    mode: 'aws',
    region: 'ap-southeast-1',
    stagingBucket: 'deployed-staging',
  });

  const options = createS3ClientConfig(config);

  assert.equal(options.region, 'ap-southeast-1');
  assert.equal(Object.hasOwn(options, 'endpoint'), false);
  assert.equal(Object.hasOwn(options, 'credentials'), false);
  assert.equal(Object.hasOwn(options, 'forcePathStyle'), false);
  assert.equal(options.ignoreConfiguredEndpointUrls, true);

  for (const endpoint of ['', 'http://localhost:5000']) {
    assert.throws(
      () => readStorageConfig({
        ...awsEnv,
        S3_ENDPOINT: endpoint,
      }),
      /S3_ENDPOINT/,
    );
  }

  for (const key of ['AWS_REGION', 'S3_STAGING_BUCKET']) {
    assert.throws(() => readStorageConfig({
      ...awsEnv,
      [key]: undefined,
    }));
  }
});

test('SDK endpoint environment overrides cannot change either selected mode', () => {
  for (const env of [motoEnv, awsEnv]) {
    for (const key of ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3']) {
      assert.throws(
        () => readStorageConfig({
          ...env,
          [key]: 'https://unexpected.example',
        }),
        /endpoint overrides/,
      );
    }
  }
});

test('Moto uses explicit dummy credentials despite real environment credentials or a missing profile', async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'real-key-must-not-be-used');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'real-secret-must-not-be-used');
  vi.stubEnv('AWS_SESSION_TOKEN', 'real-session-must-not-be-used');
  vi.stubEnv('AWS_PROFILE', 'nonexistent-profile-must-not-load');

  try {
    const client = new S3Client(createS3ClientConfig(readStorageConfig(motoEnv)));
    const credentials = await client.config.credentials();

    assert.equal(credentials.accessKeyId, 'moto-local');
    assert.equal(credentials.secretAccessKey, 'moto-local-secret');
    assert.equal(credentials.sessionToken, undefined);
    assert.equal(client.config.forcePathStyle, true);

    client.destroy();
  } finally {
    vi.unstubAllEnvs();
  }
});

test('injected signing targets only unique staging keys with PDF headers and five-minute expiry', async () => {
  const date = new Date('2026-10-21T12:00:00.000Z');
  const signUrl = vi.fn<typeof getSignedUrl>()
    .mockResolvedValue('https://signed.test/upload');

  const sign = createUploadSigner(readStorageConfig(motoEnv), {
    signUrl,
    now: () => date,
  });

  const first = await sign();
  const second = await sign();

  assert.notEqual(first.uploadId, second.uploadId);
  assert.match(first.uploadId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first, {
    uploadId: first.uploadId,
    method: 'PUT',
    url: 'https://signed.test/upload',
    headers: {
      'Content-Type': 'application/pdf',
    },
    expiresAt: '2026-10-21T12:05:00.000Z',
  });

  for (const [i, upload] of [first, second].entries()) {
    const [, rawCommand, options] = signUrl.mock.calls[i];
    const command = rawCommand as PutObjectCommand;

    assert.deepEqual(command.input, {
      Bucket: 'pdf-staging',
      Key: `uploads/${upload.uploadId}.pdf`,
      ContentType: 'application/pdf',
    });

    assert.equal(options?.expiresIn, 300);
    assert.equal(options?.signingDate, date);
    assert.deepEqual(options?.signableHeaders, new Set(['content-type']));
  }
});

test('actual offline SDK signature has PDF content type, local credentials, no empty-body checksum and 300s validity', async () => {
  const now = () => new Date('2026-10-21T12:00:00.000Z');
  const sign = createUploadSigner(readStorageConfig(motoEnv), { now });
  const authorization = await sign();
  const url = new URL(authorization.url);

  assert.equal(url.origin, 'http://localhost:5000');
  assert.equal(url.pathname, `/pdf-staging/uploads/${authorization.uploadId}.pdf`);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(url.searchParams.get('X-Amz-Date'), '20261021T120000Z');

  assert.match(
    url.searchParams.get('X-Amz-Credential') ?? '',
    /^moto-local\//,
  );

  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  assert.deepEqual(authorization.headers, {
    'Content-Type': 'application/pdf',
  });
  assert.equal(url.searchParams.get('X-Amz-Content-Sha256'), 'UNSIGNED-PAYLOAD');
  assert.equal(url.searchParams.has('X-Amz-Security-Token'), false);

  for (const key of url.searchParams.keys()) {
    assert.doesNotMatch(
      key,
      /checksum/i,
      'signer must not bind an absent body checksum',
    );
  }
});

test('signer failures propagate to the caller without logging secrets or signed URLs', async () => {
  const secret = new Error('sensitive signing diagnostic');
  const signUrl = vi.fn<typeof getSignedUrl>().mockRejectedValue(secret);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await assert.rejects(
      createUploadSigner(readStorageConfig(motoEnv), { signUrl })(),
      secret,
    );

    assert.equal(log.mock.calls.length, 0);
    assert.equal(error.mock.calls.length, 0);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

test('valid local configuration still starts the server without contacting storage', async () => {
  const result = await startServer(motoEnv);

  assert.equal(result.listening, true);
});

test('AWS default credential chain signs offline for the regional bucket without local overrides', async () => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'deployment-offline-test');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'deployment-offline-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', undefined);
  vi.stubEnv('AWS_PROFILE', undefined);

  // Even an ambient endpoint added after validation cannot redirect the SDK.
  vi.stubEnv('AWS_ENDPOINT_URL', 'http://localhost:7777');
  vi.stubEnv('AWS_ENDPOINT_URL_S3', 'http://localhost:7778');

  try {
    const authorization = await createUploadSigner(readStorageConfig(awsEnv))();
    const url = new URL(authorization.url);

    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'deployed-staging.s3.ap-southeast-1.amazonaws.com');
    assert.equal(url.pathname, `/uploads/${authorization.uploadId}.pdf`);

    assert.match(
      url.searchParams.get('X-Amz-Credential') ?? '',
      /^deployment-offline-test\//,
    );

    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  } finally {
    vi.unstubAllEnvs();
  }
});

test('documented environment example is sufficient for a valid local storage target', async () => {
  const example = await readFile(new URL('../.env.example', import.meta.url), 'utf8');

  const env = Object.fromEntries(
    example.split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ]),
  );

  assert.deepEqual(readStorageConfig(env), readStorageConfig(motoEnv));
});
