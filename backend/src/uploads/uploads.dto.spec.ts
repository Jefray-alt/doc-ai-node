import { describe, expect, it } from 'vitest';
import { PresignUploadRequestSchema } from './uploads.dto.js';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';

describe('PresignUploadRequestSchema', () => {
  it('accepts the exact upload boundaries and preserves the filename', () => {
    expect(
      PresignUploadRequestSchema.parse({
        filename: 'Quarterly.Report.PDF',
        contentType: 'application/pdf',
        sizeBytes: MAX_UPLOAD_BYTES,
      }),
    ).toEqual({
      filename: 'Quarterly.Report.PDF',
      contentType: 'application/pdf',
      sizeBytes: MAX_UPLOAD_BYTES,
    });

    expect(
      PresignUploadRequestSchema.parse({
        filename: 'one-byte.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1,
      }).sizeBytes,
    ).toBe(1);
  });

  it.each([
    null,
    [],
    {},
    { filename: 'notes.txt', contentType: 'application/pdf', sizeBytes: 1 },
    { filename: 'notes.pdf', contentType: 'Application/pdf', sizeBytes: 1 },
    { filename: 'notes.pdf', contentType: 'application/pdf', sizeBytes: 0 },
    { filename: 'notes.pdf', contentType: 'application/pdf', sizeBytes: 1.5 },
    { filename: 'notes.pdf', contentType: 'application/pdf', sizeBytes: MAX_UPLOAD_BYTES + 1 },
    { filename: 12, contentType: 'application/pdf', sizeBytes: 1 },
    { filename: 'notes.pdf', contentType: ['application/pdf'], sizeBytes: 1 },
    { filename: 'notes.pdf', contentType: 'application/pdf', sizeBytes: '1' },
  ])('rejects malformed or out-of-policy metadata: %j', (input) => {
    expect(() => PresignUploadRequestSchema.parse(input)).toThrow();
  });
});
