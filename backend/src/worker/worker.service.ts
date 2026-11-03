import { DeleteMessageCommand, ReceiveMessageCommand, ChangeMessageVisibilityCommand, SQSClient, type Message } from '@aws-sdk/client-sqs';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MAX_UPLOAD_BYTES } from '../uploads/uploads.constants.js';
import { JobsStorageService } from '../jobs/jobs-storage.service.js';
import { OutboxPublisherService } from '../jobs/outbox-publisher.service.js';
import type { JobRecord } from '../jobs/jobs.types.js';
import { retryDelaySeconds, type WorkerConfig } from './worker.config.js';

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
export const WORKER_SQS = Symbol('WORKER_SQS');
export const WORKER_S3 = Symbol('WORKER_S3');

interface QueueReference { uploadId: string; payloadVersion: 1 }

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name);
  private readonly stopController = new AbortController();
  private loops: Promise<void>[] = [];
  private activeController: AbortController | undefined;

  constructor(
    private readonly jobs: JobsStorageService,
    private readonly publisher: OutboxPublisherService,
    @Inject(WORKER_SQS) private readonly sqs: SQSClient,
    @Inject(WORKER_S3) private readonly s3: S3Client,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  start(): void {
    this.loops = [
      this.runLoop('outbox', async (signal) => {
        const result = await this.publisher.dispatchOnce(signal);
        if (result.released > 0) this.logger.warn(JSON.stringify({ event: 'worker_outbox_retry', released: result.released }));
        await sleep(1000, signal);
      }),
      this.runLoop('queue', (signal) => this.consumeOne(signal)),
      this.runLoop('dead-letter', (signal) => this.reconcileOne(signal)),
    ];
  }

  async stop(): Promise<void> {
    this.stopController.abort();
    this.activeController?.abort();
    await Promise.all(this.loops);
  }

  closeClients(): void {
    this.s3.destroy();
    this.sqs.destroy();
  }

  private async runLoop(name: string, iteration: (signal: AbortSignal) => Promise<void>): Promise<void> {
    let failures = 0;
    while (!this.stopController.signal.aborted) {
      try {
        await iteration(this.stopController.signal);
        failures = 0;
      } catch (error) {
        if (this.stopController.signal.aborted) break;
        failures += 1;
        this.logger.error(JSON.stringify({ event: 'worker_loop_error', loop: name, failures, error: safeError(error) }));
        await sleep(Math.min(30_000, 250 * 2 ** Math.min(failures - 1, 7)), this.stopController.signal).catch(() => {});
      }
    }
  }

  private async consumeOne(signal: AbortSignal): Promise<void> {
    const result = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: this.config.queueUrl,
      WaitTimeSeconds: this.config.pollWaitSeconds,
      MaxNumberOfMessages: 1,
      VisibilityTimeout: this.config.visibilityTimeoutSeconds,
    }), { abortSignal: signal });
    const receivedAt = Date.now();
    const message = result.Messages?.[0];
    if (!message) return;
    const reference = parseReference(message.Body);
    if (!reference) {
      await this.defer(message, this.config.retryDelaySeconds, this.config.queueUrl, signal);
      this.log('worker_invalid_message', undefined, undefined, 'malformed_message');
      return;
    }

    const ownerToken = randomUUID();
    const claim = await this.jobs.claimJob(reference.uploadId, ownerToken, this.config.leaseMs);
    if (claim.kind === 'busy') {
      await this.defer(message, Math.max(1, Math.ceil(this.config.heartbeatMs * 2 / 1000)), this.config.queueUrl, signal);
      this.log('worker_job_busy', reference.uploadId);
      return;
    }
    if (claim.kind === 'terminal' || claim.kind === 'missing') {
      if (claim.kind === 'missing') {
        await this.defer(message, this.config.retryDelaySeconds, this.config.queueUrl, signal);
        this.log('worker_job_missing', reference.uploadId, undefined, 'unknown_job');
      } else {
        await this.ack(message, signal);
        this.log('worker_job_terminal_duplicate', reference.uploadId);
      }
      return;
    }

    if (signal.aborted) return;
    await this.processClaim(message, claim.job, ownerToken, signal, receivedAt);
  }

  private async processClaim(message: Message, job: JobRecord, ownerToken: string, stopSignal: AbortSignal, receivedAt: number): Promise<void> {
    const controller = new AbortController();
    const abortOnStop = (): void => controller.abort(stopSignal.reason);
    if (stopSignal.aborted) abortOnStop();
    else stopSignal.addEventListener('abort', abortOnStop, { once: true });
    this.activeController = controller;
    let processingActive = true;
    const startedAt = Date.now();
    let heartbeatBusy = false;
    let heartbeatTask: Promise<void> | undefined;
    let leaseDeadline = job.leaseExpiresAt?.getTime() ?? Date.now() + this.config.leaseMs;
    let visibilityDeadline = receivedAt + this.config.visibilityTimeoutSeconds * 1000;
    const deadlineMarginMs = Math.max(1, Math.min(1000, Math.floor(Math.min(this.config.heartbeatMs, this.config.leaseMs, this.config.visibilityTimeoutSeconds * 1000) / 4)));
    let deadlineTimer: NodeJS.Timeout | undefined;
    const armDeadline = (): void => {
      if (!processingActive || controller.signal.aborted) return;
      clearTimeout(deadlineTimer);
      const deadline = Math.min(leaseDeadline, visibilityDeadline) - deadlineMarginMs;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        controller.abort(new Error('worker lease or visibility deadline reached'));
        return;
      }
      deadlineTimer = setTimeout(() => controller.abort(new Error('worker lease or visibility deadline reached')), remaining);
    };
    armDeadline();
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || controller.signal.aborted) return;
      heartbeatBusy = true;
      heartbeatTask = (async () => {
        const renewStartedAt = Date.now();
        const renewed = await this.jobs.renewJob(job.uploadId, ownerToken, this.config.leaseMs);
        if (!processingActive || controller.signal.aborted) return;
        if (!renewed) throw new Error('job lease was lost');
        leaseDeadline = renewStartedAt + this.config.leaseMs;
        armDeadline();
        if (!processingActive || controller.signal.aborted) return;
        const visibilityRenewStartedAt = Date.now();
        await this.sqs.send(new ChangeMessageVisibilityCommand({
          QueueUrl: this.config.queueUrl, ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: this.config.visibilityTimeoutSeconds,
        }), { abortSignal: controller.signal });
        if (!processingActive || controller.signal.aborted) return;
        visibilityDeadline = visibilityRenewStartedAt + this.config.visibilityTimeoutSeconds * 1000;
        armDeadline();
      })().catch((error: unknown) => {
        if (!processingActive || controller.signal.aborted) return;
        this.log('worker_heartbeat_failed', job.uploadId, job.attempts, 'lease_lost');
        controller.abort(error);
      }).finally(() => { heartbeatBusy = false; });
    }, this.config.heartbeatMs);

    try {
      if (controller.signal.aborted) return;
      const bytes = await this.checkSource(job, controller.signal);
      clearInterval(heartbeat);
      await waitForTaskOrAbort(heartbeatTask, controller.signal);
      if (controller.signal.aborted || stopSignal.aborted) return;
      const finalized = await this.jobs.finalizeJob(job.uploadId, ownerToken);
      if (!finalized) throw new Error('job lease was lost before finalization');
      await this.ack(message, controller.signal);
      this.log('worker_source_checked', job.uploadId, job.attempts, undefined, Date.now() - startedAt, bytes);
    } catch (error) {
      clearInterval(heartbeat);
      await waitForTaskOrAbort(heartbeatTask, controller.signal);
      if (stopSignal.aborted) return;
      if (controller.signal.aborted) {
        await this.defer(message, this.config.retryDelaySeconds, this.config.queueUrl, stopSignal).catch(() => {});
        return;
      }
      const classification = classifySourceError(error);
      if (classification.permanent) {
        const failed = await this.jobs.failJob(job.uploadId, ownerToken, classification.safeMessage);
        if (failed) await this.ack(message, stopSignal);
        this.log('worker_source_failed', job.uploadId, job.attempts, classification.category, Date.now() - startedAt);
      } else {
        await this.jobs.releaseJob(job.uploadId, ownerToken, classification.safeMessage);
        await this.defer(message, retryDelaySeconds(job.attempts, this.config.retryDelaySeconds, this.config.retryDelayMaxSeconds), this.config.queueUrl, stopSignal);
        this.log('worker_source_retry', job.uploadId, job.attempts, 'transient_storage', Date.now() - startedAt);
      }
    } finally {
      processingActive = false;
      controller.abort(new Error('job processing ended'));
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
      stopSignal.removeEventListener('abort', abortOnStop);
      this.activeController = undefined;
    }
  }

  private async checkSource(job: JobRecord, signal: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(job.sizeBytes) || job.sizeBytes < 1 || job.sizeBytes > MAX_UPLOAD_BYTES) {
      throw permanent('invalid_size', 'Uploaded PDF size is invalid');
    }
    const response = await this.s3.send(new GetObjectCommand({
      Bucket: job.bucket, Key: job.key, IfMatch: job.etag,
    }), { abortSignal: signal });
    const body = response.Body;
    if (!body || !(Symbol.asyncIterator in Object(body))) throw permanent('missing_body', 'Uploaded PDF body is unavailable');
    let size = 0;
    let bodyDestroyed = false;
    const destroyBody = (): void => {
      if (bodyDestroyed) return;
      bodyDestroyed = true;
      (body as { destroy?: (error?: Error) => void }).destroy?.();
    };
    signal.addEventListener('abort', destroyBody, { once: true });
    try {
      if (signal.aborted) {
        destroyBody();
        throw signal.reason ?? new Error('source validation aborted');
      }
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        size += chunk.byteLength;
        if (size > MAX_UPLOAD_BYTES) throw permanent('oversized', 'Uploaded PDF exceeds the allowed size');
      }
    } catch (error) {
      destroyBody();
      if (isPermanent(error)) throw error;
      if (signal.aborted) throw signal.reason ?? error;
      throw error;
    } finally {
      signal.removeEventListener('abort', destroyBody);
    }
    if (size !== job.sizeBytes) throw permanent('size_mismatch', 'Uploaded PDF size does not match the confirmed upload');
    return size;
  }

  private async reconcileOne(signal: AbortSignal): Promise<void> {
    const result = await this.sqs.send(new ReceiveMessageCommand({
      QueueUrl: this.config.dlqUrl, WaitTimeSeconds: this.config.pollWaitSeconds, MaxNumberOfMessages: 1,
      VisibilityTimeout: Math.min(300, this.config.visibilityTimeoutSeconds),
    }), { abortSignal: signal });
    const message = result.Messages?.[0];
    if (!message) return;
    const reference = parseReference(message.Body);
    if (reference) await this.jobs.reconcileDeadLetter(reference.uploadId, 'Upload job exceeded retry limit');
    await this.defer(message, 300, this.config.dlqUrl, signal);
    this.log('worker_dead_letter_retained', reference?.uploadId, undefined, reference ? 'redriven' : 'malformed_dead_letter');
  }

  private async ack(message: Message, signal?: AbortSignal): Promise<void> {
    if (!message.ReceiptHandle) throw new Error('SQS message receipt is missing');
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: message.ReceiptHandle }), signal ? { abortSignal: signal } : undefined);
  }

  private async defer(message: Message, seconds: number, queueUrl = this.config.queueUrl, signal?: AbortSignal): Promise<void> {
    if (!message.ReceiptHandle) throw new Error('SQS message receipt is missing');
    await this.sqs.send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle,
      VisibilityTimeout: Math.min(43200, Math.max(0, seconds)),
    }), signal ? { abortSignal: signal } : undefined);
  }

  private log(event: string, uploadId?: string, attempt?: number, failureCategory?: string, durationMs?: number, bytes?: number): void {
    this.logger.log(JSON.stringify({ event, ...(uploadId ? { uploadId } : {}), ...(attempt !== undefined ? { attempt } : {}), ...(failureCategory ? { failureCategory } : {}), ...(durationMs !== undefined ? { durationMs } : {}), ...(bytes !== undefined ? { bytes } : {}) }));
  }
}

function parseReference(body?: string): QueueReference | undefined {
  try {
    const value = JSON.parse(body ?? '') as Partial<QueueReference>;
    return typeof value.uploadId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.uploadId) && value.payloadVersion === 1
      ? { uploadId: value.uploadId, payloadVersion: 1 }
      : undefined;
  } catch { return undefined; }
}

function permanent(category: string, safeMessage: string): Error & { permanent: true; category: string; safeMessage: string } {
  return Object.assign(new Error(safeMessage), { permanent: true as const, category, safeMessage });
}

function classifySourceError(error: unknown): { permanent: boolean; category: string; safeMessage: string } {
  if (isPermanent(error)) return error;
  const name = error && typeof error === 'object' ? String((error as { name?: unknown }).name ?? '') : '';
  if (['PreconditionFailed', 'NoSuchKey', 'NotFound'].includes(name)) {
    return { permanent: true, category: 'source_changed_or_missing', safeMessage: 'Uploaded PDF is missing or changed' };
  }
  return { permanent: false, category: 'transient_storage', safeMessage: 'Temporary storage validation failure' };
}

function isPermanent(error: unknown): error is Error & { permanent: true; category: string; safeMessage: string } {
  return !!error && typeof error === 'object' && (error as { permanent?: unknown }).permanent === true;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 80) : 'unknown worker error';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    function done(): void { signal.removeEventListener('abort', abort); resolve(); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function waitForTaskOrAbort(task: Promise<void> | undefined, signal: AbortSignal): Promise<void> {
  if (!task || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => { signal.removeEventListener('abort', onAbort); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
    void task.finally(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}
