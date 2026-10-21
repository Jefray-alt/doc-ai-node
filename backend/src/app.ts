import express from 'express';

import type { UploadSigner } from './storage/storage.types.ts';
import { createUploadRouter } from './uploads/route.ts';

export function createApp(signUpload: UploadSigner) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/uploads/presign', createUploadRouter(signUpload));

  return app;
}
