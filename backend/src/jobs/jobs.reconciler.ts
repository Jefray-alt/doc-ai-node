import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { JobRecord } from './jobs.repository.js';
import { JobsRepository } from './jobs.repository.js';

const CHECK_INTERVAL_MS = 5_000;
const HEAD_TIMEOUT_MS = 5_000;
const EXPIRY_GRACE_MS = 10 * 60_000;
const MAX_BATCH_SIZE = 25;

function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = error as {
    name?: string;
    code?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };

  const status = details.$metadata?.httpStatusCode;
  if (status !== undefined) return status === 404;

  return ['NotFound', 'NoSuchKey', 'NotFoundException'].includes(details.name ?? '') ||
    ['NotFound', 'NoSuchKey', '404'].includes(details.code ?? details.Code ?? '');
}

@Injectable()
export class JobsReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsReconciler.name);
  private readonly shutdownController = new AbortController();
  private loopPromise: Promise<void> | undefined;
  private activeCycle: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly jobs: JobsRepository,
    private readonly s3: S3Client,
  ) {}

  private now(): Date {
    return new Date();
  }

  onModuleInit(): void {
    this.loopPromise = this.runLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.shutdownController.abort();
    const activeWork = [this.loopPromise, this.activeCycle]
      .filter((promise): promise is Promise<void> => promise !== undefined);
    await Promise.all(activeWork);
  }

  async reconcileOnce(): Promise<void> {
    if (this.stopping) return;
    if (this.activeCycle) return this.activeCycle;
    const cycle = this.reconcileDueUploads();
    this.activeCycle = cycle;
    try {
      await cycle;
    } finally {
      if (this.activeCycle === cycle) this.activeCycle = undefined;
    }
  }

  private async reconcileDueUploads(): Promise<void> {
    let due: JobRecord[];
    try {
      due = await this.jobs.findDueAwaitingUploads(MAX_BATCH_SIZE, this.now());
    } catch (error) {
      this.logger.error(
        'Failed to fetch due uploads for reconciliation',
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }

    for (const job of due) {
      if (this.stopping) return;
      await this.reconcileUpload(job);
    }
  }

  private async reconcileUpload(job: JobRecord): Promise<void> {
    let missing = false;
    try {
      await this.sendHeadObject(job);
    } catch (error) {
      if (this.stopping) return;
      if (isMissingObject(error)) {
        missing = true;
      } else {
        this.logger.error(
          `Failed to check upload ${job.uploadId}`,
          error instanceof Error ? error.stack : String(error),
        );
        await this.persist(job.uploadId, () =>
          this.jobs.retryUploadCheck(job.uploadId, new Date(this.now().getTime() + CHECK_INTERVAL_MS)),
        );
        return;
      }
    }

    if (!missing) {
      await this.persist(job.uploadId, () => this.jobs.confirmUpload(job.uploadId));
      return;
    }

    const graceEndsAt = job.uploadExpiresAt.getTime() + EXPIRY_GRACE_MS;
    if (this.now().getTime() > graceEndsAt) {
      await this.persist(job.uploadId, () => this.jobs.expireMissingUpload(job.uploadId));
    } else {
      await this.persist(job.uploadId, () =>
        this.jobs.retryUploadCheck(job.uploadId, new Date(this.now().getTime() + CHECK_INTERVAL_MS)),
      );
    }
  }

  private async sendHeadObject(job: JobRecord): Promise<void> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error('S3 HeadObject request timed out')),
      HEAD_TIMEOUT_MS,
    );
    const abortSignal = AbortSignal.any([
      this.shutdownController.signal,
      timeoutController.signal,
    ]);

    let rejectAborted!: (reason?: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => rejectAborted(
      abortSignal.reason ?? new Error('S3 HeadObject request aborted'),
    );

    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const request = this.s3.send(
        new HeadObjectCommand({ Bucket: job.bucket, Key: job.objectKey }),
        { abortSignal },
      );
      await Promise.race([request, aborted]);
    } finally {
      clearTimeout(timeout);
      abortSignal.removeEventListener('abort', onAbort);
    }
  }

  private async persist(uploadId: string, update: () => Promise<boolean>): Promise<void> {
    try {
      await update();
    } catch (error) {
      this.logger.error(
        `Failed to persist reconciliation for upload ${uploadId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      await this.reconcileOnce();
      if (this.stopping) return;
      await new Promise<void>((resolve) => {
        const signal = this.shutdownController.signal;
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, CHECK_INTERVAL_MS);
        signal.addEventListener('abort', finish, { once: true });
      });
    }
  }
}
