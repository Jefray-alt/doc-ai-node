import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test, vi } from 'vitest';

import { createApp } from '../src/app.ts';
import { HttpError } from '../src/errors/http-error.ts';
import { errorDiagnostics, logger } from '../src/logger.ts';

test.each([
  [new HttpError(409, 'CONFLICT', 'Keep this message.'), 409,
    { code: 'CONFLICT', message: 'Keep this message.' }],
  [new Error('secret upstream details'), 500,
    { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' }],
])('central middleware preserves HTTP errors and safely handles unexpected failures', async (error, status, body) => {
  const router = express.Router();
  router.post('/', () => { throw error; });
  const log = vi.spyOn(logger, 'error').mockImplementation(() => {});
  const server = createApp(router).listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/uploads/presign`, { method: 'POST' });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: body });
    expect(log).toHaveBeenCalledTimes(status >= 500 ? 1 : 0);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret upstream details');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
  }
});

test('diagnostics retain safe SDK categories and numeric retry details only', () => {
  const error = Object.assign(new Error('secret credential and URL'), {
    name: 'CredentialsProviderError',
    $metadata: { httpStatusCode: 403, attempts: 3, totalRetryDelay: 100, requestId: 'secret' },
  });
  expect(errorDiagnostics(error)).toEqual({
    name: 'CredentialsProviderError', httpStatusCode: 403, attempts: 3, totalRetryDelay: 100,
  });
  expect(errorDiagnostics({ name: 'secret', $metadata: { attempts: 'secret' } }))
    .toEqual({ name: 'UnknownError' });
});

test('the app builds without a signer argument using route-owned storage configuration', () => {
  vi.stubEnv('STORAGE_MODE', 'moto');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('S3_STAGING_BUCKET', 'pdf-staging');
  vi.stubEnv('S3_ENDPOINT', 'http://localhost:5000');
  try {
    expect(createApp()).toBeTypeOf('function');
  } finally {
    vi.unstubAllEnvs();
  }
});
