import { describe, expect, it } from 'vitest';

import { MAX_UPLOAD_BYTES, uploadMetadataSchema, validateUploadMetadata } from './validation.ts';

const valid = { filename: 'document.pdf', size: 1024, contentType: 'application/pdf' };

describe('uploadMetadataSchema', () => {
  it('accepts valid metadata and normalizes an empty content type', () => {
    expect(validateUploadMetadata(valid)).toEqual(valid);
    expect(validateUploadMetadata({ ...valid, filename: 'DOCUMENT.PDF', contentType: '' }))
      .toEqual({ ...valid, filename: 'DOCUMENT.PDF' });
  });

  it.each([
    null,
    [],
    {},
    { ...valid, filename: 'document.txt' },
    { ...valid, size: 0 },
    { ...valid, size: MAX_UPLOAD_BYTES + 1 },
    { ...valid, size: 1.5 },
    { ...valid, contentType: 'text/plain' },
    { ...valid, key: 'client-selected.pdf' },
  ])('rejects invalid or unknown metadata fields: %j', (value) => {
    expect(uploadMetadataSchema.safeParse(value).success).toBe(false);
    expect(validateUploadMetadata(value)).toBeUndefined();
  });
});
