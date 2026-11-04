import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { getS3StorageConfig } from './s3-storage.config.js';

export const S3_STORAGE_CONFIG = Symbol('S3_STORAGE_CONFIG');
export const S3_CLIENT = Symbol('S3_CLIENT');

export function createS3Client(config: ReturnType<typeof getS3StorageConfig>): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
  });
}

@Module({
  providers: [
    { provide: S3_STORAGE_CONFIG, useFactory: getS3StorageConfig },
    {
      provide: S3_CLIENT,
      inject: [S3_STORAGE_CONFIG],
      useFactory: createS3Client,
    },
  ],
  exports: [S3_CLIENT, S3_STORAGE_CONFIG],
})
export class S3StorageModule {}
