import express from 'express';

import { createUploadRouter } from './uploads/route.ts';

export function createApiRouter() {
  const router = express.Router();

  router.use('/uploads/presign', createUploadRouter());

  return router;
}
