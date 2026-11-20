import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { DownloadTooLargeError } from '../ingestion/pdf-downloader.errors.js';
import { PdfExtractionError, PdfInputVerificationError, PdfPageLimitError } from '../ingestion/pdf-extractor.errors.js';
import type { ClaimedJobRecord, ClaimableJobStatus, JobRecord } from './jobs.repository.js';
import { JobsRepository } from './jobs.repository.js';
import { JobLease } from './jobs.lease.ts';

const CHECK_INTERVAL_MS = 5_000;
const HEAD_TIMEOUT_MS = 5_000;
const EXPIRY_GRACE_MS = 10 * 60_000;

interface JobAttempt {
  job: ClaimedJobRecord;
  outcomeStarted: boolean;
  lease: JobLease;
}

function terminalExtractionCode(error: unknown): string | undefined {
  if (error instanceof PdfInputVerificationError || error instanceof PdfExtractionError) return error.code;
  if (error instanceof DownloadTooLargeError) return 'PDF_TOO_LARGE';
  if (error instanceof PdfPageLimitError) return 'PDF_TOO_MANY_PAGES';
  return undefined;
}

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
  private activeCycle: Promise<boolean> | undefined;
  private stopping = false;
  private preferUploaded = false;

  constructor(
    private readonly jobs: JobsRepository,
    private readonly s3: S3Client,
    private readonly ingestion: IngestionService,
  ) { }

  private now(): Date {
    return new Date();
  }

  onModuleInit(): void {
    this.logger.log('Starting job poller...');
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
    await this.reconcileOneDueJob();
  }

  private async reconcileOneDueJob(): Promise<boolean> {
    if (this.stopping) return false;
    if (this.activeCycle) return this.activeCycle;
    const cycle = this.reconcileDueJobs();
    this.activeCycle = cycle;
    try {
      return await cycle;
    } finally {
      if (this.activeCycle === cycle) this.activeCycle = undefined;
    }
  }

  private async reconcileDueJobs(): Promise<boolean> {
    const statuses = this.preferUploaded
      ? ['uploaded', 'awaiting_upload'] as const
      : ['awaiting_upload', 'uploaded'] as const;
    try {
      for (const status of statuses) {
        const due = status === 'uploaded'
          ? await this.jobs.claimNextDueUploaded()
          : await this.jobs.claimNextDueAwaitingUpload();
        if (!due) {
          if (this.stopping) return false;
          continue;
        }

        const attempt: JobAttempt = {
          job: due,
          outcomeStarted: false,
          lease: new JobLease(this.shutdownController.signal,
            () => this.jobs.renewClaim(due.uploadId, due.claimToken, status),
            (error) => this.logger.error(
              `Failed to renew claim for upload ${due.uploadId}`,
              error instanceof Error ? error.stack : String(error),
            )),
        };
        try {
          if (this.stopping) return false;
          // Give the other status first choice next time, even after a failed attempt.
          this.preferUploaded = status === 'awaiting_upload';
          return await (status === 'uploaded' ? this.extractUpload(attempt) : this.reconcileUpload(attempt));
        } finally {
          await attempt.lease.stopAndJoin();
          // An issued outcome may have committed even if its response was lost.
          // Uncertain ownership or writes must recover through expiry.
          if (this.stopping && !attempt.outcomeStarted && !attempt.lease.abandoned) {
            await this.releaseClaim(due, status);
          }
        }
      }
    } catch (error) {
      this.logger.error(
        'Failed to fetch due jobs for reconciliation',
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }

    return false;
  }

  private async extractUpload(attempt: JobAttempt): Promise<boolean> {
    const { job } = attempt;
    let pageCount = 0;
    try {
      await this.ingestion.extract(job.bucket, job.objectKey, () => {
        pageCount += 1;
      }, attempt.lease.signal);
    } catch (error) {
      if (this.stopping || attempt.lease.abandoned) return false;
      this.logger.error(
        `Failed to extract upload ${job.uploadId}`,
        error instanceof Error ? error.stack : String(error),
      );
      const terminalCode = terminalExtractionCode(error);
      if (terminalCode) {
        return this.persist(attempt, () => this.jobs.failExtraction(job.uploadId, job.claimToken, terminalCode));
      }
      await this.persist(attempt, () => this.jobs.retryExtraction(
        job.uploadId, job.claimToken, 'PDF_PROCESSING_FAILED', new Date(this.now().getTime() + CHECK_INTERVAL_MS),
      ));
      return false;
    }

    if (this.stopping || attempt.lease.abandoned) return false;
    return this.persist(
      attempt,
      () => this.jobs.completeExtraction(job.uploadId, job.claimToken, pageCount),
      `PDF extracted for ${job.uploadId} (uploaded -> extracted, ${pageCount} pages)`,
    );
  }

  private async reconcileUpload(attempt: JobAttempt): Promise<boolean> {
    const { job } = attempt;
    let missing = false;
    try {
      await this.sendHeadObject(job, attempt.lease.signal);
    } catch (error) {
      if (this.stopping || attempt.lease.abandoned) return false;
      if (isMissingObject(error)) {
        missing = true;
      } else {
        this.logger.error(
          `Failed to check upload ${job.uploadId}`,
          error instanceof Error ? error.stack : String(error),
        );
        await this.persist(attempt, () =>
          this.jobs.retryUploadCheck(job.uploadId, job.claimToken, new Date(this.now().getTime() + CHECK_INTERVAL_MS)),
        );
        return false;
      }
    }

    if (this.stopping || attempt.lease.abandoned) return false;
    if (!missing) {
      return this.persist(
        attempt,
        () => this.jobs.confirmUpload(job.uploadId, job.claimToken),
        `Upload confirmed for ${job.uploadId} (awaiting_upload -> uploaded)`,
      );
    }

    const graceEndsAt = job.uploadExpiresAt.getTime() + EXPIRY_GRACE_MS;
    if (this.now().getTime() > graceEndsAt) {
      return this.persist(
        attempt,
        () => this.jobs.expireMissingUpload(job.uploadId, job.claimToken),
        `Upload expired for ${job.uploadId} (awaiting_upload -> expired)`,
      );
    }

    return this.persist(attempt, () =>
      this.jobs.retryUploadCheck(job.uploadId, job.claimToken, new Date(this.now().getTime() + CHECK_INTERVAL_MS)),
    );
  }

  private async sendHeadObject(job: JobRecord, attemptSignal: AbortSignal): Promise<void> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error('S3 HeadObject request timed out')),
      HEAD_TIMEOUT_MS,
    );
    const abortSignal = AbortSignal.any([
      attemptSignal,
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

  private async persist(
    attempt: JobAttempt,
    update: () => Promise<boolean>,
    successMessage?: string,
  ): Promise<boolean> {
    await attempt.lease.stopAndJoin();
    if (this.stopping || attempt.lease.abandoned) return false;
    attempt.outcomeStarted = true;
    try {
      const updated = await update();
      if (updated && successMessage) this.logger.log(successMessage);
      return updated;
    } catch (error) {
      this.logger.error(
        `Failed to persist reconciliation for upload ${attempt.job.uploadId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  private async releaseClaim(job: ClaimedJobRecord, status: ClaimableJobStatus): Promise<void> {
    try {
      await this.jobs.releaseClaim(job.uploadId, job.claimToken, status);
    } catch (error) {
      this.logger.error(
        `Failed to release claim for upload ${job.uploadId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const handledSuccessfully = await this.reconcileOneDueJob();
      if (this.stopping) return;
      if (handledSuccessfully) continue;
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
