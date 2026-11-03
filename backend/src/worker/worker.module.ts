import { Module, type DynamicModule } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { JobsModule } from '../jobs/jobs.module.js';
import { OutboxPublisherModule } from '../jobs/outbox-publisher.module.js';
import { JobsStorageService } from '../jobs/jobs-storage.service.js';
import { OutboxPublisherService } from '../jobs/outbox-publisher.service.js';
import { parseWorkerConfig } from './worker.config.js';
import { WORKER_CONFIG, WORKER_S3, WORKER_SQS, WorkerService } from './worker.service.js';

@Module({})
export class WorkerModule {
  static register(): DynamicModule {
    const config = parseWorkerConfig(process.env);
    return {
      module: WorkerModule,
      imports: [JobsModule, OutboxPublisherModule.register({ queueUrl: config.queueUrl, batchSize: 10, leaseMs: config.leaseMs })],
      providers: [
        { provide: WORKER_CONFIG, useValue: config },
        { provide: WORKER_SQS, useFactory: () => new SQSClient({ region: config.awsRegion, ...(config.sqsEndpointUrl ? { endpoint: config.sqsEndpointUrl } : {}), ...credentials() }) },
        { provide: WORKER_S3, useFactory: () => new S3Client({ region: config.awsRegion, ...(config.s3EndpointUrl ? { endpoint: config.s3EndpointUrl, forcePathStyle: true } : {}), ...credentials() }) },
        { provide: WorkerService, useFactory: (jobs: JobsStorageService, publisher: OutboxPublisherService, sqs: SQSClient, s3: S3Client) => new WorkerService(jobs, publisher, sqs, s3, config), inject: [JobsStorageService, OutboxPublisherService, WORKER_SQS, WORKER_S3] },
      ],
    };
  }
}

function credentials(): { credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } } {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  return accessKeyId && secretAccessKey
    ? { credentials: { accessKeyId, secretAccessKey, ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}) } }
    : {};
}
