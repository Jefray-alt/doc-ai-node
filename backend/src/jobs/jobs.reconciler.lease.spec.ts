import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfExtractionError } from '../ingestion/pdf-extractor.errors.ts';
import { JobsReconciler } from './jobs.reconciler.ts';
import { JobsRepository } from './jobs.repository.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function setup() {
  const jobs = {
    claimNextDueAwaitingUpload: vi.fn().mockResolvedValue(null),
    claimNextDueUploaded: vi.fn().mockResolvedValue({
      uploadId: 'long-job', bucket: 'pdfs', objectKey: 'document.pdf',
      status: 'uploaded', claimToken: 'owner', leaseExpiresAt: new Date(Date.now() + 120_000),
    }),
    renewClaim: vi.fn<JobsRepository['renewClaim']>().mockResolvedValue(true),
    completeExtraction: vi.fn().mockResolvedValue(true),
    failExtraction: vi.fn().mockResolvedValue(true),
    retryExtraction: vi.fn().mockResolvedValue(true),
    confirmUpload: vi.fn(), retryUploadCheck: vi.fn(), expireMissingUpload: vi.fn(),
    releaseClaim: vi.fn().mockResolvedValue(true),
  };
  const work = deferred();
  let signal!: AbortSignal;
  const ingestion = { extract: vi.fn((_bucket, _key, _consume, abortSignal: AbortSignal) => {
    signal = abortSignal;
    return work.promise;
  }) };
  const reconciler = new JobsReconciler(jobs as never, {} as never, ingestion as never);
  const outcomes = [jobs.completeExtraction, jobs.failExtraction, jobs.retryExtraction,
    jobs.confirmUpload, jobs.retryUploadCheck, jobs.expireMissingUpload, jobs.releaseClaim];
  return { jobs, work, reconciler, outcomes, signal: () => signal };
}

describe('worker ownership heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('renews throughout slow work, never overlaps requests, and leaves no timer after success', async () => {
    const { jobs, work, reconciler } = setup();
    const pending = deferred<boolean>();
    jobs.renewClaim.mockReturnValueOnce(pending.promise);
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(jobs.renewClaim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(jobs.renewClaim).toHaveBeenCalledExactlyOnceWith('long-job', 'owner', 'uploaded');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(jobs.renewClaim).toHaveBeenCalledOnce();
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jobs.renewClaim).toHaveBeenCalledTimes(3);
    work.resolve();
    await cycle;
    expect(jobs.completeExtraction).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'terminal', 'retry'] as const)('joins a pending renewal before saving %s work', async (result) => {
    const { jobs, work, reconciler } = setup();
    const pending = deferred<boolean>();
    jobs.renewClaim.mockReturnValueOnce(pending.promise);
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    if (result === 'success') work.resolve();
    else work.reject(result === 'terminal' ? new PdfExtractionError('PDF_MALFORMED') : new Error('S3 unavailable'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(jobs.renewClaim).toHaveBeenCalledOnce();
    expect(jobs.completeExtraction).not.toHaveBeenCalled();
    expect(jobs.failExtraction).not.toHaveBeenCalled();
    expect(jobs.retryExtraction).not.toHaveBeenCalled();
    pending.resolve(true);
    await cycle;
    expect(jobs[result === 'success' ? 'completeExtraction' : result === 'terminal' ? 'failExtraction' : 'retryExtraction']).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, new Error('renewal connection lost')])('aborts cancellable I/O and suppresses every write on renewal loss %s', async (loss) => {
    const { jobs, work, reconciler, outcomes, signal } = setup();
    if (loss === false) jobs.renewClaim.mockResolvedValue(false);
    else jobs.renewClaim.mockRejectedValue(loss);
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal().aborted).toBe(true);
    // Parsing ignores cancellation: the worker must still await it and discard its error.
    let finished = false;
    void cycle.then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(finished).toBe(false);
    expect(jobs.renewClaim).toHaveBeenCalledOnce();
    const shutdown = reconciler.onModuleDestroy();
    work.reject(new PdfExtractionError('PDF_MALFORMED'));
    await Promise.all([cycle, shutdown]);
    for (const outcome of outcomes) expect(outcome).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, new Error('renewal response lost')])('discards a completed result if its pending renewal returns %s', async (loss) => {
    const { jobs, work, reconciler, outcomes } = setup();
    const pending = deferred<boolean>();
    jobs.renewClaim.mockReturnValueOnce(pending.promise);
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    work.resolve();
    await vi.advanceTimersByTimeAsync(0);
    if (loss === false) pending.resolve(false);
    else pending.reject(loss);
    await cycle;
    await reconciler.onModuleDestroy();
    for (const outcome of outcomes) expect(outcome).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abandons ownership when the checked-out renewal client loses its socket', async () => {
    const { jobs, work, reconciler, outcomes, signal } = setup();
    const pending = deferred<{ rowCount: number }>();
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValueOnce({ rowCount: 0 }).mockReturnValueOnce(pending.promise),
      release: vi.fn(), connection: { stream: { destroy: vi.fn() } },
    });
    const repository = new JobsRepository({ connect: (callback: (error: undefined, client: unknown) => void) => {
      callback(undefined, client);
    } } as never);
    jobs.renewClaim.mockImplementation((...args) => repository.renewClaim(...args));
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    client.emit('error', new Error('socket disconnected'));
    await vi.advanceTimersByTimeAsync(0);
    expect(signal().aborted).toBe(true);
    work.resolve();
    pending.resolve({ rowCount: 1 });
    await cycle;
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    for (const outcome of outcomes) expect(outcome).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops renewal while an uncertain outcome write recovers through expiry', async () => {
    const { jobs, work, reconciler } = setup();
    jobs.completeExtraction.mockRejectedValue(new Error('committed response lost'));
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    work.resolve();
    await cycle;
    await vi.advanceTimersByTimeAsync(120_000);
    await reconciler.onModuleDestroy();
    expect(jobs.renewClaim).toHaveBeenCalledOnce();
    expect(jobs.releaseClaim).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, false, new Error('renewal response lost')])(
    'joins renewal on shutdown and releases only certain ownership (%s)', async (renewed) => {
      const { jobs, work, reconciler, signal } = setup();
      const pending = deferred<boolean>();
      jobs.renewClaim.mockReturnValueOnce(pending.promise);
      reconciler.onModuleInit();
      await vi.advanceTimersByTimeAsync(30_000);

      let closed = false;
      const shutdown = reconciler.onModuleDestroy().then(() => { closed = true; });
      expect(signal().aborted).toBe(true);
      work.resolve();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(closed).toBe(false);
      expect(jobs.renewClaim).toHaveBeenCalledOnce();
      expect(jobs.releaseClaim).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      if (renewed instanceof Error) pending.reject(renewed);
      else pending.resolve(renewed);
      await shutdown;
      await reconciler.reconcileOnce();
      expect(jobs.claimNextDueAwaitingUpload).toHaveBeenCalledOnce();
      expect(jobs.claimNextDueUploaded).toHaveBeenCalledOnce();
      expect(jobs.completeExtraction).not.toHaveBeenCalled();
      expect(jobs.failExtraction).not.toHaveBeenCalled();
      expect(jobs.retryExtraction).not.toHaveBeenCalled();
      expect(jobs.releaseClaim).toHaveBeenCalledTimes(renewed === true ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('discards a finished result when shutdown arrives while persistence is joining renewal', async () => {
    const { jobs, work, reconciler } = setup();
    const pending = deferred<boolean>();
    jobs.renewClaim.mockReturnValueOnce(pending.promise);
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    work.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.completeExtraction).not.toHaveBeenCalled();

    const shutdown = reconciler.onModuleDestroy();
    pending.resolve(true);
    await Promise.all([cycle, shutdown]);
    expect(jobs.completeExtraction).not.toHaveBeenCalled();
    expect(jobs.releaseClaim).toHaveBeenCalledExactlyOnceWith('long-job', 'owner', 'uploaded');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, new Error('outcome response lost')])('awaits an already-issued outcome on shutdown (%s)', async (result) => {
    const { jobs, work, reconciler } = setup();
    const pending = deferred<boolean>();
    jobs.completeExtraction.mockReturnValueOnce(pending.promise);
    reconciler.onModuleInit();
    work.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(jobs.completeExtraction).toHaveBeenCalledOnce();

    let closed = false;
    const shutdown = reconciler.onModuleDestroy().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closed).toBe(false);
    expect(jobs.renewClaim).not.toHaveBeenCalled();
    expect(jobs.releaseClaim).not.toHaveBeenCalled();
    if (result instanceof Error) pending.reject(result);
    else pending.resolve(result);
    await shutdown;
    await reconciler.reconcileOnce();
    expect(jobs.claimNextDueUploaded).toHaveBeenCalledOnce();
    expect(jobs.completeExtraction).toHaveBeenCalledOnce();
    expect(jobs.releaseClaim).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([true, new Error('release unavailable')])('awaits best-effort release on shutdown (%s)', async (result) => {
    const { jobs, work, reconciler } = setup();
    const pending = deferred<boolean>();
    jobs.releaseClaim.mockReturnValueOnce(pending.promise);
    const cycle = reconciler.reconcileOnce();
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const shutdown = reconciler.onModuleDestroy().then(() => { closed = true; });
    expect(jobs.releaseClaim).not.toHaveBeenCalled();
    work.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closed).toBe(false);
    expect(jobs.releaseClaim).toHaveBeenCalledExactlyOnceWith('long-job', 'owner', 'uploaded');
    expect(jobs.renewClaim).not.toHaveBeenCalled();
    if (result instanceof Error) pending.reject(result);
    else pending.resolve(result);
    await Promise.all([cycle, shutdown]);
    expect(jobs.completeExtraction).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
