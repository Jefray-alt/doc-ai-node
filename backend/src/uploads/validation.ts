import { z } from 'zod';

import type { UploadMetadata } from './uploads.types.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const uploadMetadataSchema = z.object({
  filename: z.string().regex(/\.pdf$/i),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  contentType: z.union([z.literal('application/pdf'), z.literal('')])
    .transform((): 'application/pdf' => 'application/pdf'),
}).strict();

export function validateUploadMetadata(value: unknown): UploadMetadata | undefined {
  const result = uploadMetadataSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
