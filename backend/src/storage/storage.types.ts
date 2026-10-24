export type StorageConfig = {
  region: string;
  stagingBucket: string;
} & (
  | {
    mode: 'moto';
    endpoint: string;
  }
  | {
    mode: 'aws';
  }
);

export interface UploadAuthorization {
  uploadId: string;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export type UploadSigner = () => Promise<UploadAuthorization>;
