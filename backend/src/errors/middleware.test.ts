import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { logger } from '../logger.ts';
import { HttpError } from './http-error.ts';
import { handleError } from './middleware.ts';

function responseStub() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { response: { headersSent: false, status } as unknown as Response, status, json };
}

describe('handleError', () => {
  it('preserves known HTTP errors', () => {
    const { response, status, json } = responseStub();
    handleError(new HttpError(409, 'CONFLICT', 'Conflict.'), {} as never, response, vi.fn());
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ error: { code: 'CONFLICT', message: 'Conflict.' } });
  });

  it('uses endpoint-neutral messages for oversized and malformed JSON', () => {
    for (const [error, statusCode, code, message] of [
      [{ type: 'entity.too.large' }, 413, 'JSON_TOO_LARGE', 'Request body exceeds the allowed size.'],
      [{ type: 'entity.parse.failed' }, 400, 'INVALID_JSON', 'Send valid JSON.'],
    ] as const) {
      const { response, status, json } = responseStub();
      handleError(error, {} as never, response, vi.fn());
      expect(status).toHaveBeenCalledWith(statusCode);
      expect(json).toHaveBeenCalledWith({ error: { code, message } });
    }
  });

  it('logs safe diagnostics and returns a generic response for unexpected errors', () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { response, status, json } = responseStub();
    handleError(new Error('credential=secret'), {} as never, response, vi.fn());
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('credential=secret');
    errorLog.mockRestore();
  });

  it('passes errors onward when the response has already started', () => {
    const next = vi.fn();
    const error = new Error('late failure');
    handleError(error, {} as never, { headersSent: true } as Response, next);
    expect(next).toHaveBeenCalledWith(error);
  });
});
