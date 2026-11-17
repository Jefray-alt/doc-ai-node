import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadTooLargeError } from '../ingestion/pdf-downloader.errors.js';
import { PdfExtractionError, PdfInputVerificationError, PdfPageLimitError } from '../ingestion/pdf-extractor.errors.js';
import type { PdfPageConsumer } from '../ingestion/pdf-extractor.types.js';
import type { JobRecord } from './jobs.repository.js';
import { JobsReconciler } from './jobs.reconciler.js';

const now = new Date('2026-01-01T00:00:00.000Z');
const uploaded: JobRecord = {
  uploadId: 'uploaded', bucket: 'pdfs', objectKey: 'incoming/document.pdf',
  status: 'uploaded', pageCount: null, errorCode: null,
  claimToken: 'owner-token', leaseExpiresAt: new Date(now.getTime() + 120_000),
  uploadExpiresAt: now, nextCheckAt: now, createdAt: now, updatedAt: now,
};

function setup() {
  const jobs = {
    claimNextDueAwaitingUpload: vi.fn().mockResolvedValue(null),
    claimNextDueUploaded: vi.fn().mockResolvedValue(uploaded),
    releaseClaim: vi.fn().mockResolvedValue(true),
    confirmUpload: vi.fn().mockResolvedValue(true),
    completeExtraction: vi.fn().mockResolvedValue(true),
    failExtraction: vi.fn().mockResolvedValue(true),
    retryExtraction: vi.fn().mockResolvedValue(true),
  };
  const ingestion = {
    extract: vi.fn(async (_bucket: string, _key: string, consume: PdfPageConsumer, _signal?: AbortSignal) => {
      await consume({ pageNumber: 1, text: 'first page' });
      await consume({ pageNumber: 2, text: '' });
      await consume({ pageNumber: 3, text: 'last page' });
    }),
  };
  const s3 = { send: vi.fn().mockResolvedValue({}) };
  const reconciler = new JobsReconciler(jobs as never, s3 as never, ingestion as never);
  return { jobs, ingestion, s3, reconciler };
}

describe('JobsReconciler PDF ingestion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('counts physical pages including blanks and saves only after extraction finishes', async () => {
    const { jobs, ingestion, reconciler } = setup();
    ingestion.extract.mockImplementationOnce(async (_bucket, _key, consume) => {
      await consume({ pageNumber: 1, text: 'first page' });
      await consume({ pageNumber: 2, text: '' });
      expect(jobs.completeExtraction).not.toHaveBeenCalled();
      await consume({ pageNumber: 3, text: 'last page' });
    });

    await reconciler.reconcileOnce();

    expect(jobs.claimNextDueUploaded).toHaveBeenCalledWith();
    expect(ingestion.extract).toHaveBeenCalledWith('pdfs', 'incoming/document.pdf', expect.any(Function), expect.any(AbortSignal));
    expect(jobs.completeExtraction).toHaveBeenCalledExactlyOnceWith('uploaded', 'owner-token', 3);
    expect(jobs.failExtraction).not.toHaveBeenCalled();
    expect(jobs.retryExtraction).not.toHaveBeenCalled();
  });

  it.each([
    [new PdfInputVerificationError('PDF_TOO_LARGE'), 'PDF_TOO_LARGE'],
    [new DownloadTooLargeError(20, 21), 'PDF_TOO_LARGE'],
    [new PdfInputVerificationError('PDF_INVALID_HEADER'), 'PDF_INVALID_HEADER'],
    [new PdfPageLimitError(100), 'PDF_TOO_MANY_PAGES'],
    [new PdfExtractionError('PDF_MALFORMED'), 'PDF_MALFORMED'],
    [new PdfExtractionError('PDF_PASSWORD_REQUIRED'), 'PDF_PASSWORD_REQUIRED'],
    [new PdfExtractionError('PDF_NO_TEXT'), 'PDF_NO_TEXT'],
  ])('stores terminal code %s as %s without persisting partial pages', async (error, code) => {
    const { jobs, ingestion, reconciler } = setup();
    ingestion.extract.mockImplementationOnce(async (_bucket, _key, consume) => {
      await consume({ pageNumber: 1, text: '' });
      throw error;
    });

    await reconciler.reconcileOnce();

    expect(jobs.failExtraction).toHaveBeenCalledExactlyOnceWith('uploaded', 'owner-token', code);
    expect(jobs.completeExtraction).not.toHaveBeenCalled();
    expect(jobs.retryExtraction).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to extract upload uploaded', error.stack);
  });

  it('retries operational failures in five seconds with a stable code and logs the original error', async () => {
    const { jobs, ingestion, reconciler } = setup();
    const error = new Error('temporary S3 failure with private details');
    ingestion.extract.mockImplementationOnce(async (_bucket, _key, consume) => {
      await consume({ pageNumber: 1, text: 'partial text' });
      throw error;
    });

    await reconciler.reconcileOnce();

    expect(jobs.retryExtraction).toHaveBeenCalledExactlyOnceWith('uploaded', 'owner-token', 'PDF_PROCESSING_FAILED', new Date(now.getTime() + 5_000));
    expect(jobs.completeExtraction).not.toHaveBeenCalled();
    expect(jobs.failExtraction).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith('Failed to extract upload uploaded', error.stack);
  });

  it.each(['completeExtraction', 'failExtraction', 'retryExtraction'] as const)(
    'waits five seconds when %s returns false or rejects', async (method) => {
      for (const rejects of [false, true]) {
        const { jobs, ingestion, reconciler } = setup();
        if (method !== 'completeExtraction') {
          ingestion.extract.mockRejectedValue(method === 'failExtraction'
            ? new PdfExtractionError('PDF_MALFORMED') : new Error('unavailable'));
        }
        if (rejects) jobs[method].mockRejectedValue(new Error('database unavailable'));
        else jobs[method].mockResolvedValue(false);
        reconciler.onModuleInit();

        await vi.advanceTimersByTimeAsync(0);
        expect(jobs[method]).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(ingestion.extract).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(ingestion.extract).toHaveBeenCalledTimes(2);
        await reconciler.onModuleDestroy();
      }
    },
  );

  it('waits five seconds after an operational failure even when its retry write succeeds', async () => {
    const { jobs, ingestion, reconciler } = setup();
    ingestion.extract.mockRejectedValue(new Error('unavailable'));
    reconciler.onModuleInit();

    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.retryExtraction).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(ingestion.extract).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(ingestion.extract).toHaveBeenCalledTimes(2);
    await reconciler.onModuleDestroy();
  });

  it('drains successful extraction jobs immediately and recovers an uploaded job after restart', async () => {
    const { jobs, ingestion, reconciler } = setup();
    jobs.claimNextDueUploaded.mockResolvedValueOnce(uploaded).mockResolvedValueOnce({ ...uploaded, uploadId: 'second' }).mockResolvedValue(null);
    jobs.completeExtraction.mockResolvedValueOnce(false).mockResolvedValue(true);
    await reconciler.reconcileOnce();
    expect(jobs.completeExtraction).toHaveBeenCalledWith('uploaded', 'owner-token', 3);
    await reconciler.onModuleDestroy();

    // After lease expiry a restarted worker can reclaim the original uploaded row.
    jobs.claimNextDueUploaded.mockReset().mockResolvedValueOnce(uploaded).mockResolvedValueOnce({ ...uploaded, uploadId: 'second' }).mockResolvedValue(null);
    const restarted = new JobsReconciler(jobs as never, {} as never, ingestion as never);
    restarted.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);

    expect(jobs.completeExtraction.mock.calls).toEqual([['uploaded', 'owner-token', 3], ['uploaded', 'owner-token', 3], ['second', 'owner-token', 3]]);
    await restarted.onModuleDestroy();
  });

  it('coalesces concurrent requests while extracting and never starts a second document', async () => {
    const { jobs, ingestion, reconciler } = setup();
    let finish!: () => void;
    ingestion.extract.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(0);
    const second = reconciler.reconcileOnce();
    expect(ingestion.extract).toHaveBeenCalledOnce();
    expect(jobs.claimNextDueUploaded).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(jobs.completeExtraction).toHaveBeenCalledOnce();
  });

  it('alternates due upload checks and extraction when both queues remain busy', async () => {
    const { jobs, ingestion, s3, reconciler } = setup();
    jobs.claimNextDueAwaitingUpload.mockResolvedValue({ ...uploaded, status: 'awaiting_upload' });

    for (let index = 0; index < 6; index++) {
      await reconciler.reconcileOnce();
      expect(s3.send.mock.calls.length + ingestion.extract.mock.calls.length).toBe(index + 1);
      expect(Math.abs(s3.send.mock.calls.length - ingestion.extract.mock.calls.length)).toBeLessThanOrEqual(1);
    }
    expect(s3.send).toHaveBeenCalledTimes(3);
    expect(ingestion.extract).toHaveBeenCalledTimes(3);
  });

  it('backs off a failed uploaded lookup and retries it on the next cycle', async () => {
    const { jobs, reconciler } = setup();
    jobs.claimNextDueUploaded.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(null);
    reconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(jobs.claimNextDueUploaded).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(jobs.claimNextDueUploaded).toHaveBeenCalledTimes(2);
    await reconciler.onModuleDestroy();
  });

  it('aborts the active download on shutdown without writing a failure or starting more work', async () => {
    const { jobs, ingestion, reconciler } = setup();
    let signal!: AbortSignal;
    ingestion.extract.mockImplementationOnce((_bucket, _key, _consume, abortSignal) => {
      signal = abortSignal!;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    reconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    await reconciler.onModuleDestroy();
    await reconciler.reconcileOnce();

    expect(signal.aborted).toBe(true);
    expect(ingestion.extract).toHaveBeenCalledOnce();
    expect(jobs.completeExtraction).not.toHaveBeenCalled();
    expect(jobs.failExtraction).not.toHaveBeenCalled();
    expect(jobs.retryExtraction).not.toHaveBeenCalled();
  });

  it.each([false, true])('awaits uninterruptible parsing on shutdown and discards its stale outcome (fails=%s)', async (fails) => {
    const { jobs, ingestion, reconciler } = setup();
    let finish!: () => void;
    ingestion.extract.mockImplementationOnce(async (_bucket, _key, consume) => {
      await consume({ pageNumber: 1, text: 'partial' });
      await new Promise<void>((resolve) => { finish = resolve; });
      if (fails) throw new PdfExtractionError('PDF_MALFORMED');
      await consume({ pageNumber: 2, text: 'late page' });
    });
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const shutdown = reconciler.onModuleDestroy().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    expect(jobs.releaseClaim).not.toHaveBeenCalled();
    finish();
    await Promise.all([cycle, shutdown]);

    expect(closed).toBe(true);
    expect(jobs.releaseClaim).toHaveBeenCalledExactlyOnceWith('uploaded', 'owner-token', 'uploaded');
    expect(jobs.completeExtraction).not.toHaveBeenCalled();
    expect(jobs.failExtraction).not.toHaveBeenCalled();
    expect(jobs.retryExtraction).not.toHaveBeenCalled();
  });
});
