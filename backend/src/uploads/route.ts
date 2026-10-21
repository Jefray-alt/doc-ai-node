import express from 'express';
import type { ErrorRequestHandler } from 'express';

import type { UploadSigner } from '../storage/storage.types.ts';
import { validateUploadMetadata } from './validation.ts';

export function createUploadRouter(signUpload: UploadSigner) {
  const router = express.Router();

  router.post('/', express.json({ limit: '4kb' }), async (req, res) => {
    if (!req.is('application/json')) {
      res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: 'Send upload metadata as application/json.',
        },
      });

      return;
    }

    if (!validateUploadMetadata(req.body)) {
      res.status(400).json({
        error: {
          code: 'INVALID_UPLOAD_METADATA',
          message: 'Provide a .pdf filename, an integer size from 1 to 10485760 bytes, and contentType application/pdf or empty. No other fields are allowed.',
        },
      });

      return;
    }

    try {
      const authorization = await signUpload();

      res.status(201).json(authorization);
    } catch {
      res.status(503).json({
        error: {
          code: 'SIGNING_UNAVAILABLE',
          message: 'Upload authorization is unavailable. Please try again.',
        },
      });
    }
  });

  const handleJsonError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const oversized = typeof error === 'object'
      && error !== null
      && 'type' in error
      && error.type === 'entity.too.large';

    res.status(oversized ? 413 : 400).json({
      error: {
        code: oversized ? 'JSON_TOO_LARGE' : 'INVALID_JSON',
        message: oversized
          ? 'Upload metadata JSON must not exceed 4096 bytes.'
          : 'Send valid upload metadata JSON.',
      },
    });
  };

  router.use(handleJsonError);

  return router;
}
