import { createZodDto } from 'nestjs-zod';
import { extname } from 'node:path';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from './uploads.constants.js';

export const PresignUploadRequestSchema = z.object({
  filename: z.string().refine((filename) => extname(filename).toLowerCase() === '.pdf'),
  contentType: z.literal('application/pdf'),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

export class PresignUploadDto extends createZodDto(PresignUploadRequestSchema) {}

export type PresignUploadRequest = z.infer<typeof PresignUploadRequestSchema>;

export type PresignedUploadResponse = {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
};
