import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JobsStorageService } from './jobs-storage.service.js';

export interface OutboxPublisherConfig {
  queueUrl: string;
  batchSize?: number;
  leaseMs?: number;
}

export interface OutboxDispatchResult {
  claimed: number;
  sent: number;
  released: number;
}

export const OUTBOX_PUBLISHER_CONFIG = Symbol('OUTBOX_PUBLISHER_CONFIG');

@Injectable()
export class OutboxPublisherService implements OnModuleDestroy {
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(
    private readonly jobs: JobsStorageService,
    private readonly sqs: SQSClient,
    @Inject(OUTBOX_PUBLISHER_CONFIG) private readonly config: OutboxPublisherConfig,
  ) {
    if (!config.queueUrl?.trim()) throw new Error('SQS queue URL is required');
    this.batchSize = config.batchSize ?? 10;
    this.leaseMs = config.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 10) {
      throw new Error('Outbox batch size must be an integer from 1 to 10');
    }
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) {
      throw new Error('Outbox lease must be a positive integer');
    }
  }

  onModuleDestroy(): void {
    this.sqs.destroy();
  }

  async dispatchOnce(): Promise<OutboxDispatchResult> {
    const ownerToken = randomUUID();
    const messages = await this.jobs.claimOutbox(this.batchSize, ownerToken, this.leaseMs);
    const result: OutboxDispatchResult = { claimed: messages.length, sent: 0, released: 0 };

    for (const message of messages) {
      try {
        await this.sqs.send(new SendMessageCommand({
          QueueUrl: this.config.queueUrl,
          MessageBody: JSON.stringify({ uploadId: message.uploadId, payloadVersion: message.payloadVersion }),
          DelaySeconds: 0,
        }));
      } catch {
        await this.jobs.releaseOutbox(message.uploadId, message.ownerToken, 'queue delivery failed');
        result.released += 1;
        continue;
      }

      await this.jobs.markOutboxSent(message.uploadId, message.ownerToken);
      result.sent += 1;
    }
    return result;
  }
}

export function createOutboxSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT_URL;
  return new SQSClient({
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  });
}
