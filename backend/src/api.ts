import express from 'express';
import type { Router } from 'express';

import { createUploadRouter } from './uploads/route.ts';

export function createApiRouter(uploadRouter: Router = createUploadRouter()) {
  const router = express.Router();

  router.use('/uploads/presign', uploadRouter);

  return router;
}
