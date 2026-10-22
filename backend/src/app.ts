import express from 'express';
import type { Router } from 'express';

import { handleError } from './errors/middleware.ts';
import { createUploadRouter } from './uploads/route.ts';

export function createApp(uploadRouter: Router = createUploadRouter()) {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/uploads/presign', uploadRouter);
  app.use(handleError);

  return app;
}
