import type { S3ClientConfig } from '@aws-sdk/client-s3';

import type { StorageConfig } from './storage.types.ts';

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];

  if (!value || value !== value.trim()) {
    throw new Error(`${key} must be configured without surrounding whitespace`);
  }

  return value;
}

export function readStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig {
  const mode = required(env, 'STORAGE_MODE');

  if (mode !== 'moto' && mode !== 'aws') {
    throw new Error('STORAGE_MODE must be moto or aws');
  }

  const region = required(env, 'AWS_REGION');

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/.test(region)) {
    throw new Error('AWS_REGION must be an AWS region name');
  }

  const stagingBucket = required(env, 'S3_STAGING_BUCKET');

  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(stagingBucket)
    || stagingBucket.includes('..')
    || /(?:\.-|-\.)/.test(stagingBucket)
    || /^\d+\.\d+\.\d+\.\d+$/.test(stagingBucket)
  ) {
    throw new Error('S3_STAGING_BUCKET must be a valid S3 bucket name');
  }

  // Never let SDK environment/profile endpoint settings bypass the selected mode.
  if (
    env.AWS_ENDPOINT_URL !== undefined
    || env.AWS_ENDPOINT_URL_S3 !== undefined
  ) {
    throw new Error(
      'AWS endpoint overrides are unsupported; use S3_ENDPOINT in Moto mode',
    );
  }

  if (mode === 'aws') {
    if (env.S3_ENDPOINT !== undefined) {
      throw new Error('S3_ENDPOINT must be unset in AWS mode');
    }

    return {
      mode,
      region,
      stagingBucket,
    };
  }

  const endpoint = required(env, 'S3_ENDPOINT');
  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('S3_ENDPOINT must be a loopback HTTP or HTTPS origin');
  }

  if (
    !['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/'
  ) {
    throw new Error('S3_ENDPOINT must be a loopback HTTP or HTTPS origin');
  }

  return {
    mode,
    region,
    stagingBucket,
    endpoint: url.origin,
  };
}

export function createS3ClientConfig(config: StorageConfig): S3ClientConfig {
  const shared: S3ClientConfig = {
    region: config.region,
    ignoreConfiguredEndpointUrls: true,

    // The backend has no file bytes; do not sign an optional empty-body checksum.
    requestChecksumCalculation: 'WHEN_REQUIRED',
  };

  if (config.mode === 'moto') {
    return {
      ...shared,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'moto-local',
        secretAccessKey: 'moto-local-secret',
      },
    };
  }

  // Omit endpoint, path style and credentials so AWS resolves regional endpoints
  // and the default credential chain (deployment role in production).
  return shared;
}
