import express from 'express';

import { createApiRouter } from './api.ts';
import { handleError } from './errors/middleware.ts';

export function createApp() {
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', createApiRouter());
  app.use(handleError);

  return app;
}
