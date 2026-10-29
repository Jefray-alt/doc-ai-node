import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { QuarantinePromotionService } from '../uploads/quarantine-promotion.service.js';
import { SCAN_WORKER_CONFIG, SQS_CLIENT } from './scan-worker.config.js';
import type { ScanWorkerConfig } from './scan-worker.config.js';

const EVENT_SOURCE = 'aws.guardduty';
const EVENT_TYPE = 'GuardDuty Malware Protection Object Scan Result';
const UPLOAD_KEY_PATTERN = /^incoming\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.pdf$/i;

interface ScanEvent {
  id: string;
  source: string;
  'detail-type': string;
  detail: {
    resourceType: string;
    scanStatus: string;
    scanResultDetails: { scanResultStatus: string };
    s3ObjectDetails: {
      bucketName: string;
      objectKey: string;
      versionId: string;
      eTag: string;
    };
  };
}

interface ParsedEvent {
  eventId: string;
  sourceKey: string;
  uploadId: string;
  versionId: string;
  etag: string;
  promote: boolean;
  outcome: string;
}

interface ActiveWork {
  controller: AbortController;
  promise: Promise<void>;
}

@Injectable()
export class ScanWorkerService {
  private readonly logger = new Logger(ScanWorkerService.name);
  private readonly active = new Set<ActiveWork>();
  private readonly shutdownController = new AbortController();
  private stopping = false;
  private pollController?: AbortController;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly promotion: QuarantinePromotionService,
    @Inject(SCAN_WORKER_CONFIG) private readonly config: ScanWorkerConfig,
  ) {}

  async run(): Promise<void> {
    this.logger.log(`Scan worker started with concurrency ${this.config.concurrency}`);
    while (!this.stopping) {
      const freeSlots = this.config.concurrency - this.active.size;
      if (freeSlots <= 0) {
        await Promise.race([...this.active].map((work) => work.promise));
        continue;
      }

      const controller = new AbortController();
      this.pollController = controller;
      let messages: Message[] = [];
      try {
        const response = await this.sqs.send(new ReceiveMessageCommand({
          QueueUrl: this.config.queueUrl,
          MaxNumberOfMessages: Math.min(freeSlots, 10),
          WaitTimeSeconds: 20,
          VisibilityTimeout: this.config.visibilityTimeoutSeconds,
        }), { abortSignal: controller.signal });
        messages = response.Messages ?? [];
      } catch (error) {
        if (!this.stopping) {
          this.logger.error(`SQS receive failed: ${this.errorMessage(error)}`);
          await this.waitForPollInterval();
        }
      } finally {
        if (this.pollController === controller) this.pollController = undefined;
      }

      if (this.stopping) break;
      if (messages.length === 0) {
        await this.waitForPollInterval();
        continue;
      }
      const allowed = Math.min(freeSlots, 10);
      for (const message of messages.slice(0, allowed)) this.startMessage(message);
    }
    this.logger.log('Scan worker polling stopped');
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.shutdownController.abort();
    this.pollController?.abort();
    const activeAtShutdown = [...this.active];
    if (activeAtShutdown.length > 0) {
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(activeAtShutdown.map((work) => work.promise)),
        new Promise<void>((resolve) => { shutdownTimer = setTimeout(resolve, this.config.shutdownGraceMs); }),
      ]);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      for (const work of activeAtShutdown) work.controller.abort(new Error('Worker shutdown grace period ended'));
      await Promise.allSettled(activeAtShutdown.map((work) => work.promise));
    }
    this.logger.log('Scan worker shutdown complete');
  }

  async processMessage(message: Message): Promise<void> {
    await this.processMessageWithController(message, new AbortController());
  }

  private startMessage(message: Message): void {
    const controller = new AbortController();
    const work: ActiveWork = {
      controller,
      promise: Promise.resolve().then(() => this.processMessageWithController(message, controller)),
    };
    this.active.add(work);
    void work.promise.finally(() => this.active.delete(work));
  }

  private async processMessageWithController(message: Message, controller: AbortController): Promise<void> {
    const startedAt = Date.now();
    let parsed: ParsedEvent;
    try {
      parsed = this.parseMessage(message);
    } catch (error) {
      const identity = message.MessageId ? ` messageId=${message.MessageId}` : '';
      this.logger.error(`Scan message left for retry${identity} durationMs=${Date.now() - startedAt}: ${this.errorMessage(error)}`);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Processing deadline exceeded'));
        reject(new Error('Processing deadline exceeded'));
      }, this.config.processingDeadlineMs);
      controller.signal.addEventListener('abort', () => {
        if (timer) clearTimeout(timer);
        reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Processing aborted'));
      }, { once: true });
    });
    try {
      const work = async () => {
        if (parsed.promote) {
          await this.promotion.promote({
            uploadId: parsed.uploadId,
            sourceKey: parsed.sourceKey,
            versionId: parsed.versionId,
            etag: parsed.etag,
            signal: controller.signal,
          });
        }
        if (controller.signal.aborted) throw new Error('Processing deadline exceeded');
        if (!message.ReceiptHandle) throw new Error('SQS message has no receipt handle');
        await this.sqs.send(new DeleteMessageCommand({
          QueueUrl: this.config.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }), { abortSignal: controller.signal });
        if (controller.signal.aborted) throw new Error('Processing deadline exceeded');
        this.logger.log(`Scan message acknowledged eventId=${this.safeLogValue(parsed.eventId)} versionId=${this.safeLogValue(parsed.versionId)} outcome=${parsed.outcome} durationMs=${Date.now() - startedAt}`);
      };
      await Promise.race([work(), deadline]);
    } catch (error) {
      const identity = [
        message.MessageId ? `messageId=${message.MessageId}` : '',
        `eventId=${this.safeLogValue(parsed.eventId)}`,
        `versionId=${this.safeLogValue(parsed.versionId)}`,
        `outcome=${parsed.outcome}`,
      ].filter(Boolean).join(' ');
      this.logger.error(`Scan message left for retry ${identity} durationMs=${Date.now() - startedAt}: ${this.errorMessage(error)}`);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private parseMessage(message: Message): ParsedEvent {
    if (!message.Body) throw new Error('SQS message body is empty');
    let event: ScanEvent;
    try {
      event = JSON.parse(message.Body) as ScanEvent;
    } catch {
      throw new Error('SQS message body is not valid JSON');
    }
    const detail = event?.detail;
    const object = detail?.s3ObjectDetails;
    if (event?.source !== EVENT_SOURCE || event['detail-type'] !== EVENT_TYPE) {
      throw new Error('Unexpected EventBridge source or detail type');
    }
    if (typeof event.id !== 'string' || event.id.trim() === '') throw new Error('EventBridge event ID is required');
    if (detail?.resourceType !== 'S3_OBJECT') throw new Error('GuardDuty resource type must be S3_OBJECT');
    if (object?.bucketName !== this.config.quarantineBucket) throw new Error('Scan event bucket does not match configured quarantine bucket');
    const keyMatch = typeof object.objectKey === 'string' ? UPLOAD_KEY_PATTERN.exec(object.objectKey) : null;
    if (!keyMatch) throw new Error('Scan event key must identify an incoming UUID PDF');
    if (typeof object.versionId !== 'string' || !object.versionId.trim() || object.versionId.trim().toLowerCase() === 'null') {
      throw new Error('Scan event must include a non-null S3 version ID');
    }
    if (typeof object.eTag !== 'string' || object.eTag.length === 0) throw new Error('Scan event must include an ETag');

    const scanStatus = detail.scanStatus;
    const result = detail.scanResultDetails?.scanResultStatus;
    const outcome = `${scanStatus}/${result}`;
    const promote = scanStatus === 'COMPLETED' && result === 'NO_THREATS_FOUND';
    const acknowledge = promote
      || (scanStatus === 'COMPLETED' && result === 'THREATS_FOUND')
      || (scanStatus === 'SKIPPED' && (result === 'UNSUPPORTED' || result === 'ACCESS_DENIED'))
      || (scanStatus === 'FAILED' && result === 'FAILED');
    if (!acknowledge) throw new Error('Unrecognized GuardDuty scan outcome');

    const hasQuotes = object.eTag.startsWith('"') && object.eTag.endsWith('"');
    const opaqueEtag = hasQuotes ? object.eTag.slice(1, -1) : object.eTag;
    const hasInvalidTagCharacter = [...opaqueEtag].some((character) => {
      const code = character.charCodeAt(0);
      return code !== 0x21 && !(code >= 0x23 && code <= 0x7e) && !(code >= 0x80 && code <= 0xff);
    });
    if (!opaqueEtag || hasInvalidTagCharacter) throw new Error('Scan event ETag is not a valid entity tag');
    const etag = `"${opaqueEtag}"`;
    return {
      eventId: event.id,
      sourceKey: object.objectKey,
      uploadId: keyMatch[1],
      versionId: object.versionId,
      etag,
      promote,
      outcome,
    };
  }

  private async waitForPollInterval(): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      if (this.shutdownController.signal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.shutdownController.signal.removeEventListener('abort', onAbort);
        resolve();
      }, this.config.pollIntervalMs);
      this.shutdownController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private safeLogValue(value: string): string {
    return JSON.stringify(value.length > 128 ? `${value.slice(0, 128)}…` : value);
  }
}
