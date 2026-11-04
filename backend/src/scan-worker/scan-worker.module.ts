import { Inject, Injectable, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { getS3StorageConfig } from '../storage/s3-storage.config.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { getScanWorkerConfig, SCAN_WORKER_CONFIG, SQS_CLIENT } from './scan-worker.config.js';
import { ScanWorkerService } from './scan-worker.service.js';

export function createSqsClient(env: NodeJS.ProcessEnv = process.env): SQSClient {
  const storage = getS3StorageConfig(env);
  return new SQSClient({
    region: storage.region,
    ...(env.SQS_ENDPOINT_URL ? { endpoint: env.SQS_ENDPOINT_URL } : {}),
    ...(storage.credentials ? { credentials: storage.credentials } : {}),
  });
}

@Injectable()
class SqsClientLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

@Module({
  imports: [UploadsModule],
  providers: [
    {
      provide: SCAN_WORKER_CONFIG,
      useFactory: getScanWorkerConfig,
    },
    {
      provide: SQS_CLIENT,
      useFactory: createSqsClient,
    },
    ScanWorkerService,
    SqsClientLifecycle,
  ],
  exports: [ScanWorkerService],
})
export class ScanWorkerModule {}
