import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { createS3ClientConfig } from './config.ts';
import type { StorageConfig, UploadSigner } from './storage.types.ts';

export const UPLOAD_EXPIRY_SECONDS = 300;

interface SigningDependencies {
  signUrl?: typeof getSignedUrl;
  now?: () => Date;
}

export function createUploadSigner(
  config: StorageConfig,
  {
    signUrl = getSignedUrl,
    now = () => new Date(),
  }: SigningDependencies = {},
): UploadSigner {
  const client = new S3Client(createS3ClientConfig(config));

  return async () => {
    const uploadId = randomUUID();
    const date = now();
    const headers = {
      'Content-Type': 'application/pdf',
    };

    const command = new PutObjectCommand({
      Bucket: config.stagingBucket,
      Key: `uploads/${uploadId}.pdf`,
      ContentType: headers['Content-Type'],
    });

    const url = await signUrl(client, command, {
      expiresIn: UPLOAD_EXPIRY_SECONDS,
      signingDate: date,
      signableHeaders: new Set(['content-type']),
    });

    return {
      uploadId,
      method: 'PUT',
      url,
      headers,
      expiresAt: new Date(date.getTime() + UPLOAD_EXPIRY_SECONDS * 1000).toISOString(),
    };
  };
}
