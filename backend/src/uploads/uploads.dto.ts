export type PresignUploadRequest = {
  filename: unknown;
  contentType: unknown;
  sizeBytes: unknown;
};

export type PresignedUploadResponse = {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
};
