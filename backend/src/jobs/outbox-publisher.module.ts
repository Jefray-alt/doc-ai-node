import { Module, type DynamicModule } from '@nestjs/common';
import { JobsModule } from './jobs.module.js';
import { JobsStorageService } from './jobs-storage.service.js';
import {
  OUTBOX_PUBLISHER_CONFIG,
  OutboxPublisherService,
  createOutboxSqsClient,
  type OutboxPublisherConfig,
} from './outbox-publisher.service.js';
import { SQSClient } from '@aws-sdk/client-sqs';

export const OUTBOX_SQS_CLIENT = Symbol('OUTBOX_SQS_CLIENT');

@Module({})
export class OutboxPublisherModule {
  static register(config: OutboxPublisherConfig): DynamicModule {
    if (!config.queueUrl?.trim()) throw new Error('SQS queue URL is required');
    return {
      module: OutboxPublisherModule,
      imports: [JobsModule],
      providers: [
        { provide: OUTBOX_PUBLISHER_CONFIG, useValue: config },
        { provide: OUTBOX_SQS_CLIENT, useFactory: createOutboxSqsClient },
        {
          provide: OutboxPublisherService,
          inject: [JobsStorageService, OUTBOX_SQS_CLIENT, OUTBOX_PUBLISHER_CONFIG],
          useFactory: (jobs: JobsStorageService, sqs: SQSClient, publisherConfig: OutboxPublisherConfig) =>
            new OutboxPublisherService(jobs, sqs, publisherConfig),
        },
      ],
      exports: [OutboxPublisherService, OUTBOX_SQS_CLIENT],
    };
  }
}
