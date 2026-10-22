import type { ErrorRequestHandler } from 'express';

import { errorDiagnostics, logger } from '../logger.ts';
import { HttpError } from './http-error.ts';

export const handleError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  let httpError: HttpError;

  if (error instanceof HttpError) {
    httpError = error;
  } else if (typeof error === 'object' && error !== null
    && 'type' in error && error.type === 'entity.too.large') {
    httpError = new HttpError(413, 'JSON_TOO_LARGE', 'Request body exceeds the allowed size.');
  } else if (typeof error === 'object' && error !== null
    && 'type' in error && error.type === 'entity.parse.failed') {
    httpError = new HttpError(400, 'INVALID_JSON', 'Send valid JSON.');
  } else {
    httpError = new HttpError(500, 'INTERNAL_ERROR', 'An unexpected error occurred.', { cause: error });
  }

  if (httpError.status >= 500) {
    logger.error({
      code: httpError.code,
      error: errorDiagnostics(httpError.cause ?? error),
    }, 'Request failed');
  }

  res.status(httpError.status).json({
    error: { code: httpError.code, message: httpError.message },
  });
};
