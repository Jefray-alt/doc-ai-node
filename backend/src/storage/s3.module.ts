import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';

export function createS3Client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT_URL;
  return new S3Client({
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
}

class S3ClientLifecycle {
  constructor(private readonly s3: S3Client) {}

  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}

@Module({
  providers: [
    { provide: S3Client, useFactory: createS3Client },
    { provide: S3ClientLifecycle, useFactory: (s3: S3Client) => new S3ClientLifecycle(s3), inject: [S3Client] },
  ],
  exports: [S3Client],
})
export class S3Module {}
