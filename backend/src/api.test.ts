import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, test, vi } from 'vitest';

import { createApiRouter } from './api.ts';
import { handleError } from './errors/middleware.ts';

test('createApiRouter registers the default upload route without injected routers', async () => {
  vi.stubEnv('STORAGE_MODE', 'moto');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('S3_STAGING_BUCKET', 'pdf-staging');
  vi.stubEnv('S3_ENDPOINT', 'http://localhost:5000');

  const app = express();
  app.use('/api', createApiRouter());
  app.use(handleError);
  const server = app.listen(0, '127.0.0.1');

  try {
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/uploads/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'document.pdf', size: 1, contentType: 'application/pdf' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.unstubAllEnvs();
  }
});
