import type { UploadMetadata } from './uploads.types.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function validateUploadMetadata(value: unknown): UploadMetadata | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const metadata = value as Record<string, unknown>;
  const allowedFields = ['filename', 'size', 'contentType'];

  // Accept metadata only; in particular, callers cannot select a storage target.
  if (Object.keys(metadata).some((field) => !allowedFields.includes(field))) {
    return undefined;
  }

  const { filename, size, contentType } = metadata;

  if (typeof filename !== 'string' || !/\.pdf$/i.test(filename)) {
    return undefined;
  }

  if (
    typeof size !== 'number'
    || !Number.isInteger(size)
    || size <= 0
    || size > MAX_UPLOAD_BYTES
  ) {
    return undefined;
  }

  if (contentType !== 'application/pdf' && contentType !== '') {
    return undefined;
  }

  return {
    filename,
    size,
    contentType: 'application/pdf',
  };
}
