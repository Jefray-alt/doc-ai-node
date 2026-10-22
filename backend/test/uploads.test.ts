import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createApp } from '../src/app.ts';
import { logger } from '../src/logger.ts';
import { createUploadRouter } from '../src/uploads/route.ts';
import { createUploadSigner } from '../src/storage/signer.ts';
import type { UploadAuthorization } from '../src/storage/storage.types.ts';
import { validateUploadMetadata } from '../src/uploads/validation.ts';

const candidate = {
  filename: 'document.pdf',
  size: 1024,
  contentType: 'application/pdf',
};

const authorization: UploadAuthorization = {
  uploadId: 'test-upload-id',
  method: 'PUT',
  url: 'https://storage.invalid/uploads/test.pdf?signature=test-only',
  headers: {
    'Content-Type': 'application/pdf',
    'x-amz-required-header': 'test-only',
  },
  expiresAt: '2026-10-21T12:05:00.000Z',
};

let server: Server;
let baseUrl: string;

const signUpload = vi.fn<() => Promise<UploadAuthorization>>();

async function listen(app: ReturnType<typeof createApp>) {
  server = app.listen(0, '127.0.0.1');

  await once(server, 'listening');

  const address = server.address() as AddressInfo;

  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function postJson(body: unknown) {
  return fetch(`${baseUrl}/api/uploads/presign`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);

  const body = await response.json();

  expect(body).toEqual({
    error: {
      code,
      message: expect.any(String),
    },
  });

  expect(body.error.message.length).toBeGreaterThan(0);
  expect(signUpload).not.toHaveBeenCalled();
}

beforeEach(async () => {
  signUpload.mockReset();
  signUpload.mockResolvedValue(authorization);

  await listen(createApp(createUploadRouter(signUpload)));
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  vi.restoreAllMocks();
});

test('valid candidate metadata receives a PUT upload authorization', async () => {
  const response = await postJson(candidate);

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(authorization);
  expect(signUpload).toHaveBeenCalledExactlyOnceWith();
});

test.each([
  ['uppercase extension and empty media type', {
    filename: 'DOCUMENT.PDF',
    size: 1,
    contentType: '',
  }],
  ['maximum candidate size', {
    ...candidate,
    size: 10 * 1024 * 1024,
  }],
])('accepts %s and normalizes the declared media type', async (_label, metadata) => {
  expect(validateUploadMetadata(metadata)).toEqual({
    ...metadata,
    contentType: 'application/pdf',
  });

  const response = await postJson(metadata);

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(authorization);
  expect(signUpload).toHaveBeenCalledExactlyOnceWith();
});

test.each([
  ['null body', null],
  ['array body', [candidate]],
  ['string body', 'document.pdf'],
  ['empty object', {}],
  ['missing filename', { size: 1, contentType: '' }],
  ['null filename', { ...candidate, filename: null }],
  ['number filename', { ...candidate, filename: 123 }],
  ['empty filename', { ...candidate, filename: '' }],
  ['blank filename', { ...candidate, filename: '   ' }],
  ['wrong extension', { ...candidate, filename: 'document.txt' }],
  ['trailing extension', { ...candidate, filename: 'document.pdf.exe' }],
  ['trailing whitespace', { ...candidate, filename: 'document.pdf ' }],
  ['trailing newline', { ...candidate, filename: 'document.pdf\n' }],
  ['missing size', { filename: 'document.pdf', contentType: '' }],
  ['null size', { ...candidate, size: null }],
  ['string size', { ...candidate, size: '1024' }],
  ['boolean size', { ...candidate, size: true }],
  ['zero size', { ...candidate, size: 0 }],
  ['negative size', { ...candidate, size: -1 }],
  ['fractional size', { ...candidate, size: 1.5 }],
  ['oversized candidate', { ...candidate, size: 10 * 1024 * 1024 + 1 }],
  ['missing media type', { filename: 'document.pdf', size: 1 }],
  ['null media type', { ...candidate, contentType: null }],
  ['number media type', { ...candidate, contentType: 123 }],
  ['wrong media type', { ...candidate, contentType: 'text/plain' }],
  ['parameterized media type', { ...candidate, contentType: 'application/pdf; charset=utf-8' }],
  ['bucket selection', { ...candidate, bucket: 'ready' }],
  ['key selection', { ...candidate, key: 'chosen.pdf' }],
  ['capitalized bucket selection', { ...candidate, Bucket: 'ready' }],
  ['capitalized key selection', { ...candidate, Key: 'chosen.pdf' }],
  ['nested target', { ...candidate, target: { bucket: 'ready', key: 'chosen.pdf' } }],
  ['file bytes', { ...candidate, bytes: '%PDF-1.7' }],
])('rejects %s before invoking the signer', async (_label, metadata) => {
  const response = await postJson(metadata);

  expect(response.status).toBe(400);

  const body = await response.json();

  expect(body).toEqual({
    error: {
      code: expect.stringMatching(/^(INVALID_UPLOAD_METADATA|INVALID_JSON)$/),
      message: expect.any(String),
    },
  });

  expect(signUpload).not.toHaveBeenCalled();
});

test.each(['{"filename":', '{"filename":"secret-value.pdf",}', 'not-json', ''])(
  'returns a controlled error for malformed or empty JSON: %s',
  async (body) => {
    const response = await fetch(`${baseUrl}/api/uploads/presign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
    });

    expect(response.status).toBe(400);

    const result = await response.json();

    expect(result).toEqual({
      error: {
        code: expect.stringMatching(/^(INVALID_JSON|INVALID_UPLOAD_METADATA)$/),
        message: expect.any(String),
      },
    });

    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(signUpload).not.toHaveBeenCalled();
  },
);

test('rejects JSON above the 4096-byte body limit', async () => {
  const response = await postJson({
    ...candidate,
    filename: `${'x'.repeat(4096)}.pdf`,
  });

  await expectError(response, 413, 'JSON_TOO_LARGE');
});

test.each(['text/plain', 'application/pdf', 'multipart/form-data'])(
  'rejects non-JSON request media type %s',
  async (contentType) => {
    const response = await fetch(`${baseUrl}/api/uploads/presign`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
      },
      body: JSON.stringify(candidate),
    });

    await expectError(response, 400, 'INVALID_JSON');
  },
);

test('signing failures return a safe 503 without logging credentials or URLs', async () => {
  const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
  const logs = ['log', 'error', 'warn', 'info', 'debug'].map((method) => (
    vi.spyOn(console, method as 'log').mockImplementation(() => {})
  ));

  signUpload.mockRejectedValue(new Error(
    'credential=secret-value https://storage.invalid?X-Amz-Signature=secret-signature',
  ));

  const response = await postJson(candidate);

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: 'SIGNING_UNAVAILABLE',
      message: 'Upload authorization is unavailable. Please try again.',
    },
  });

  expect(signUpload).toHaveBeenCalledExactlyOnceWith();

  expect(errorLog).toHaveBeenCalledExactlyOnceWith({
    code: 'SIGNING_UNAVAILABLE', error: { name: 'Error' },
  }, 'Request failed');
  expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/secret-value|secret-signature|storage.invalid/);

  for (const log of logs) {
    expect(log).not.toHaveBeenCalled();
  }
});

test('successful authorization does not log the signed response', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  const response = await postJson(candidate);

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(authorization);
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test('/health retains its process-only response even when signing is unavailable', async () => {
  signUpload.mockRejectedValue(new Error('signer unavailable'));

  const response = await fetch(`${baseUrl}/health`);

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
  expect(signUpload).not.toHaveBeenCalled();
});

test('real offline signer creates distinct opaque staging authorizations over HTTP', async () => {
  server.closeAllConnections();

  await new Promise<void>((resolve) => server.close(() => resolve()));

  await listen(createApp(createUploadRouter(createUploadSigner({
    mode: 'moto',
    region: 'us-east-1',
    stagingBucket: 'pdf-staging',
    endpoint: 'http://localhost:5000',
  }, {
    now: () => new Date('2026-10-21T12:00:00.000Z'),
  }))));

  const firstResponse = await postJson(candidate);
  const secondResponse = await postJson(candidate);
  const first = await firstResponse.json();
  const second = await secondResponse.json();

  expect(firstResponse.status).toBe(201);
  expect(secondResponse.status).toBe(201);
  expect(first.uploadId).not.toBe(second.uploadId);

  for (const result of [first, second]) {
    const url = new URL(result.url);

    expect(url.pathname).toBe(`/pdf-staging/uploads/${result.uploadId}.pdf`);
    expect(url.pathname).not.toContain(candidate.filename);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(result.headers).toEqual({ 'Content-Type': 'application/pdf' });
    expect(result.expiresAt).toBe('2026-10-21T12:05:00.000Z');
  }
});

test('the documented request example works against the HTTP endpoint', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.split('## Upload authorization endpoint')[1];
  const example = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];

  expect(example).toBeDefined();

  const response = await postJson(JSON.parse(example!));

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(authorization);
});
