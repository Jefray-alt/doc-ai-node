export type PresignUploadRequest = {
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type PresignedUploadResponse = {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
};
