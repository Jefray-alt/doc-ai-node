import express from 'express';

import { HttpError } from '../errors/http-error.ts';
import { readStorageConfig } from '../storage/config.ts';
import { createUploadSigner } from '../storage/signer.ts';
import type { UploadSigner } from '../storage/storage.types.ts';
import { validateUploadMetadata } from './validation.ts';

export function createUploadRouter(
  signUpload: UploadSigner = createUploadSigner(readStorageConfig()),
) {
  const router = express.Router();

  router.post('/', express.json({ limit: '4kb' }), async (req, res) => {
    if (!req.is('application/json')) {
      throw new HttpError(400, 'INVALID_JSON', 'Send upload metadata as application/json.');
    }

    if (!validateUploadMetadata(req.body)) {
      throw new HttpError(400, 'INVALID_UPLOAD_METADATA',
        'Provide a .pdf filename, an integer size from 1 to 10485760 bytes, and contentType application/pdf or empty. No other fields are allowed.');
    }

    let authorization;
    try {
      authorization = await signUpload();
    } catch (cause) {
      throw new HttpError(503, 'SIGNING_UNAVAILABLE',
        'Upload authorization is unavailable. Please try again.', { cause });
    }

    res.status(201).json(authorization);
  });

  return router;
}
