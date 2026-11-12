import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import type { JobRecord } from './jobs.repository.js';
import { JobsReconciler } from './jobs.reconciler.js';

const now = new Date('2026-01-01T00:00:00.000Z');

function job(uploadId: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    uploadId,
    bucket: 'doc-ai-local-pdfs',
    objectKey: `incoming/${uploadId}.pdf`,
    status: 'awaiting_upload',
    uploadExpiresAt: new Date(now.getTime() - 10 * 60_000),
    nextCheckAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function missingObject() {
  return Object.assign(new Error('missing'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

describe('JobsReconciler', () => {
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

  it('checks exactly one due row per reconciliation and confirms only present objects', async () => {
    const jobs = Array.from({ length: 30 }, (_, index) => job(`upload-${index}`));
    const active: string[] = [];
    let maxActive = 0;
    const send = vi.fn(async (command: HeadObjectCommand) => {
      const key = command.input.Key!;
      active.push(key);
      maxActive = Math.max(maxActive, active.length);
      await Promise.resolve();
      active.pop();
      if (key.endsWith('upload-1.pdf')) throw missingObject();
      return {};
    });
    const repository = {
      findNextDueAwaitingUpload: vi.fn().mockResolvedValue(jobs[0]),
      confirmUpload: vi.fn().mockResolvedValue(true),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      expireMissingUpload: vi.fn().mockResolvedValue(true),
    };
    const reconciler = new JobsReconciler(repository as never, { send } as never);

    await reconciler.reconcileOnce();

    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledWith(expect.any(Date));
    expect(send).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    expect(repository.confirmUpload).toHaveBeenCalledWith('upload-0');
    expect(repository.retryUploadCheck).not.toHaveBeenCalled();
    expect(repository.expireMissingUpload).not.toHaveBeenCalled();
    expect(Logger.prototype.log).toHaveBeenCalledOnce();
    expect(Logger.prototype.log).not.toHaveBeenCalledWith(
      'Upload confirmed for upload-1 (awaiting_upload -> uploaded)',
    );
  });

  it('drains successive due rows immediately after successful handling', async () => {
    const first = job('first');
    const second = job('second');
    const repository = {
      findNextDueAwaitingUpload: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockResolvedValue(null),
      confirmUpload: vi.fn().mockResolvedValue(true),
    };
    const send = vi.fn().mockResolvedValue({});
    const reconciler = new JobsReconciler(repository as never, { send } as never);
    reconciler.onModuleInit();

    await vi.waitFor(() => expect(repository.confirmUpload).toHaveBeenCalledTimes(2));

    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(2);
    await reconciler.onModuleDestroy();
  });

  it('reschedules a missing row and immediately checks another due row', async () => {
    const repository = {
      findNextDueAwaitingUpload: vi.fn()
        .mockResolvedValueOnce(job('still-waiting', { uploadExpiresAt: new Date(now.getTime()) }))
        .mockResolvedValueOnce(job('present'))
        .mockResolvedValue(null),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      confirmUpload: vi.fn().mockResolvedValue(true),
    };
    const send = vi.fn(async (command: HeadObjectCommand) => {
      if (command.input.Key?.includes('/still-waiting.')) throw missingObject();
      return {};
    });
    const reconciler = new JobsReconciler(repository as never, { send } as never);
    reconciler.onModuleInit();

    await vi.waitFor(() => expect(repository.confirmUpload).toHaveBeenCalledOnce());

    expect(repository.retryUploadCheck).toHaveBeenCalledWith('still-waiting', expect.any(Date));
    const retryAt = repository.retryUploadCheck.mock.calls[0]?.[1] as Date;
    expect(retryAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(5_000);
    expect(retryAt.getTime() - now.getTime()).toBeLessThan(5_100);
    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(2);
    await reconciler.onModuleDestroy();
  });

  it('waits five seconds after a due-row persistence update returns false', async () => {
    const repository = {
      findNextDueAwaitingUpload: vi.fn()
        .mockResolvedValueOnce(job('write-failure'))
        .mockResolvedValue(null),
      confirmUpload: vi.fn().mockResolvedValue(false),
    };
    const reconciler = new JobsReconciler(repository as never, {
      send: vi.fn().mockResolvedValue({}),
    } as never);
    reconciler.onModuleInit();

    await vi.advanceTimersByTimeAsync(0);
    expect(repository.confirmUpload).toHaveBeenCalledOnce();
    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledTimes(2));
    await reconciler.onModuleDestroy();
  });

  it('waits five seconds after a due lookup or S3 failure', async () => {
    const failedLookup = {
      findNextDueAwaitingUpload: vi.fn()
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockResolvedValue(null),
    };
    const lookupReconciler = new JobsReconciler(failedLookup as never, { send: vi.fn() } as never);
    lookupReconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(failedLookup.findNextDueAwaitingUpload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(failedLookup.findNextDueAwaitingUpload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(failedLookup.findNextDueAwaitingUpload).toHaveBeenCalledTimes(2);
    await lookupReconciler.onModuleDestroy();

    const failedS3 = {
      findNextDueAwaitingUpload: vi.fn()
        .mockResolvedValueOnce(job('s3-failure'))
        .mockResolvedValue(null),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
    };
    const s3Reconciler = new JobsReconciler(failedS3 as never, {
      send: vi.fn().mockRejectedValue(new Error('service unavailable')),
    } as never);
    s3Reconciler.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    expect(failedS3.retryUploadCheck).toHaveBeenCalledOnce();
    expect(failedS3.findNextDueAwaitingUpload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(failedS3.findNextDueAwaitingUpload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(failedS3.findNextDueAwaitingUpload).toHaveBeenCalledTimes(2);
    await s3Reconciler.onModuleDestroy();
  });

  it('expires only a missing object beyond the grace boundary, after HEAD confirms it is still missing', async () => {
    const send = vi.fn().mockRejectedValue(missingObject());
    const repository = {
      findNextDueAwaitingUpload: vi.fn()
        .mockResolvedValueOnce(job('inside', { uploadExpiresAt: new Date(now.getTime() - 10 * 60_000 + 1) }))
        .mockResolvedValueOnce(job('boundary', { uploadExpiresAt: new Date(now.getTime() - 10 * 60_000) }))
        .mockResolvedValueOnce(job('past', { uploadExpiresAt: new Date(now.getTime() - 10 * 60_000 - 1) }))
        .mockResolvedValue(null),
      confirmUpload: vi.fn().mockResolvedValue(true),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      expireMissingUpload: vi.fn().mockResolvedValue(true),
    };
    const reconciler = new JobsReconciler(repository as never, { send } as never);

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(send).toHaveBeenCalledTimes(3);
    expect(repository.retryUploadCheck).toHaveBeenCalledTimes(2);
    expect(repository.expireMissingUpload).toHaveBeenCalledWith('past');
  });

  it('retries authorization and timeout errors with a later check instead of expiring', async () => {
    const forbidden = Object.assign(new Error('forbidden'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 403 },
    });
    const repository = {
      findNextDueAwaitingUpload: vi.fn().mockResolvedValue(job('forbidden')),
      confirmUpload: vi.fn().mockResolvedValue(true),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      expireMissingUpload: vi.fn().mockResolvedValue(true),
    };
    const reconciler = new JobsReconciler(repository as never, {
      send: vi.fn().mockRejectedValue(forbidden),
    } as never);

    await reconciler.reconcileOnce();

    expect(repository.retryUploadCheck).toHaveBeenCalledWith('forbidden', new Date(now.getTime() + 5_000));
    expect(repository.expireMissingUpload).not.toHaveBeenCalled();
  });

  it('retries S3 request timeouts and does not treat them as missing objects', async () => {
    const timeout = Object.assign(new Error('request timed out'), { name: 'AbortError' });
    const repository = {
      findNextDueAwaitingUpload: vi.fn().mockResolvedValue(job('timeout')),
      confirmUpload: vi.fn(),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      expireMissingUpload: vi.fn(),
    };
    const reconciler = new JobsReconciler(repository as never, {
      send: vi.fn().mockRejectedValue(timeout),
    } as never);

    await reconciler.reconcileOnce();

    expect(repository.retryUploadCheck).toHaveBeenCalledWith('timeout', new Date(now.getTime() + 5_000));
    expect(repository.expireMissingUpload).not.toHaveBeenCalled();
  });

  it('enforces the full HEAD deadline while S3 credential resolution is pending', async () => {
    let releaseCredentials!: (credentials: AwsCredentialIdentity) => void;
    const requestHandler = {
      handle: vi.fn(async (_request: unknown, options: { abortSignal: AbortSignal }) => {
        expect(options.abortSignal.aborted).toBe(true);
        throw options.abortSignal.reason;
      }),
    };
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: () => new Promise<AwsCredentialIdentity>((resolve) => {
        releaseCredentials = resolve;
      }),
      requestHandler: requestHandler as never,
    });
    const repository = {
      findNextDueAwaitingUpload: vi.fn().mockResolvedValue(job('credential-timeout')),
      confirmUpload: vi.fn(),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      expireMissingUpload: vi.fn(),
    };
    const reconciler = new JobsReconciler(repository as never, client);
    const cycle = reconciler.reconcileOnce();

    try {
      await vi.waitFor(() => expect(releaseCredentials).toBeTypeOf('function'));
      await vi.advanceTimersByTimeAsync(5_000);
      let settled = false;
      void cycle.then(() => { settled = true; });
      await Promise.resolve();

      expect(settled).toBe(true);
      expect(repository.retryUploadCheck).toHaveBeenCalledWith(
        'credential-timeout',
        expect.any(Date),
      );
      expect(repository.confirmUpload).not.toHaveBeenCalled();
    } finally {
      releaseCredentials({ accessKeyId: 'test', secretAccessKey: 'test' });
      await cycle.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(requestHandler.handle).toHaveBeenCalledOnce();
      expect(repository.retryUploadCheck).toHaveBeenCalledOnce();
      client.destroy();
    }
  }, 10_000);

  it('finishes shutdown before a pending S3 credential provider resolves', async () => {
    let releaseCredentials!: (credentials: AwsCredentialIdentity) => void;
    const requestHandler = {
      handle: vi.fn(async (_request: unknown, options: { abortSignal: AbortSignal }) => {
        expect(options.abortSignal.aborted).toBe(true);
        throw options.abortSignal.reason;
      }),
    };
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: () => new Promise<AwsCredentialIdentity>((resolve) => {
        releaseCredentials = resolve;
      }),
      requestHandler: requestHandler as never,
    });
    const repository = {
      findNextDueAwaitingUpload: vi.fn().mockResolvedValue(job('shutdown-credential')),
      confirmUpload: vi.fn(),
      retryUploadCheck: vi.fn(),
      expireMissingUpload: vi.fn(),
    };
    const reconciler = new JobsReconciler(repository as never, client);
    const cycle = reconciler.reconcileOnce();
    let shutdownFinished = false;
    let shutdown!: Promise<void>;

    try {
      await vi.waitFor(() => expect(releaseCredentials).toBeTypeOf('function'));
      shutdown = reconciler.onModuleDestroy().then(() => { shutdownFinished = true; });
      await vi.waitFor(() => expect(shutdownFinished).toBe(true));

      expect(repository.confirmUpload).not.toHaveBeenCalled();
      expect(repository.retryUploadCheck).not.toHaveBeenCalled();
    } finally {
      releaseCredentials({ accessKeyId: 'test', secretAccessKey: 'test' });
      await shutdown;
      await cycle.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(requestHandler.handle).toHaveBeenCalledOnce();
      expect(repository.confirmUpload).not.toHaveBeenCalled();
      expect(repository.retryUploadCheck).not.toHaveBeenCalled();
      client.destroy();
    }
  }, 10_000);

  it('waits five seconds after each completed cycle and never overlaps cycles', async () => {
    let completeFirst!: () => void;
    const repository = {
      findNextDueAwaitingUpload: vi.fn()
        .mockImplementationOnce(() => new Promise<JobRecord | null>((resolve) => {
          completeFirst = () => resolve(null);
        }))
        .mockResolvedValue(null),
    };
    const reconciler = new JobsReconciler(repository as never, { send: vi.fn() } as never);
    reconciler.onModuleInit();
    await vi.waitFor(() => expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledTimes(1);

    completeFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledTimes(2));
    await reconciler.onModuleDestroy();
  });

  it('aborts an active HEAD on shutdown and does not persist its stale result', async () => {
    let observedSignal!: AbortSignal;
    const repository = {
      findNextDueAwaitingUpload: vi.fn().mockResolvedValue(job('active')),
      confirmUpload: vi.fn(),
      retryUploadCheck: vi.fn(),
      expireMissingUpload: vi.fn(),
    };
    const s3 = {
      send: vi.fn((_command: HeadObjectCommand, options: { abortSignal: AbortSignal }) => {
        observedSignal = options.abortSignal;
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }),
    };
    const reconciler = new JobsReconciler(repository as never, s3 as never);
    reconciler.onModuleInit();
    await vi.waitFor(() => expect(s3.send).toHaveBeenCalledOnce());

    await reconciler.onModuleDestroy();

    expect(observedSignal.aborted).toBe(true);
    expect(repository.confirmUpload).not.toHaveBeenCalled();
    expect(repository.retryUploadCheck).not.toHaveBeenCalled();
  });

  it('logs a failed due-row fetch and allows the next cycle to retry', async () => {
    const repository = {
      findNextDueAwaitingUpload: vi.fn().mockRejectedValue(new Error('database unavailable')),
    };
    const reconciler = new JobsReconciler(repository as never, { send: vi.fn() } as never);

    await expect(reconciler.reconcileOnce()).resolves.toBeUndefined();
    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledOnce();
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('coalesces concurrent reconciliation requests into one in-process cycle', async () => {
    let finishFetch!: (nextJob: JobRecord | null) => void;
    const repository = {
      findNextDueAwaitingUpload: vi.fn(() => new Promise<JobRecord | null>((resolve) => {
        finishFetch = resolve;
      })),
    };
    const reconciler = new JobsReconciler(repository as never, { send: vi.fn() } as never);
    const first = reconciler.reconcileOnce();
    const second = reconciler.reconcileOnce();
    expect(repository.findNextDueAwaitingUpload).toHaveBeenCalledOnce();
    finishFetch(null);
    await Promise.all([first, second]);
  });

  it('logs a transition write failure with its upload ID and continues the cycle', async () => {
    const failure = new Error('database write failed');
    const repository = {
      findNextDueAwaitingUpload: vi.fn().mockResolvedValue(job('write-failure')),
      confirmUpload: vi.fn().mockRejectedValue(failure),
    };
    const reconciler = new JobsReconciler(repository as never, { send: vi.fn().mockResolvedValue({}) } as never);

    await expect(reconciler.reconcileOnce()).resolves.toBeUndefined();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      'Failed to persist reconciliation for upload write-failure',
      failure.stack,
    );
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('logs confirmed and expired status transitions after their repository writes succeed', async () => {
    let resolveConfirm!: (updated: boolean) => void;
    let resolveExpire!: (updated: boolean) => void;
    const repository = {
      findNextDueAwaitingUpload: vi.fn()
        .mockResolvedValueOnce(job('confirmed'))
        .mockResolvedValueOnce(job('expired', { uploadExpiresAt: new Date(now.getTime() - 10 * 60_000 - 1) })),
      confirmUpload: vi.fn(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve; })),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      expireMissingUpload: vi.fn(() => new Promise<boolean>((resolve) => { resolveExpire = resolve; })),
    };
    const reconciler = new JobsReconciler(repository as never, {
      send: vi.fn(async (command: HeadObjectCommand) => {
        if (command.input.Key?.includes('/expired.')) throw missingObject();
        return {};
      }),
    } as never);

    const cycle = reconciler.reconcileOnce();

    await vi.waitFor(() => expect(repository.confirmUpload).toHaveBeenCalledOnce());
    expect(Logger.prototype.log).not.toHaveBeenCalled();

    resolveConfirm(true);
    await cycle;
    const expiryCycle = reconciler.reconcileOnce();
    await vi.waitFor(() => expect(repository.expireMissingUpload).toHaveBeenCalledOnce());
    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Upload confirmed for confirmed (awaiting_upload -> uploaded)',
    );
    expect(Logger.prototype.log).not.toHaveBeenCalledWith(
      'Upload expired for expired (awaiting_upload -> expired)',
    );

    resolveExpire(true);
    await expiryCycle;

    expect(Logger.prototype.log).toHaveBeenCalledWith(
      'Upload expired for expired (awaiting_upload -> expired)',
    );
  });

  it('does not log successful transitions when repository writes return false', async () => {
    const repository = {
      findNextDueAwaitingUpload: vi.fn()
        .mockResolvedValueOnce(job('not-confirmed'))
        .mockResolvedValueOnce(job('not-expired', { uploadExpiresAt: new Date(now.getTime() - 10 * 60_000 - 1) })),
      confirmUpload: vi.fn().mockResolvedValue(false),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      expireMissingUpload: vi.fn().mockResolvedValue(false),
    };
    const reconciler = new JobsReconciler(repository as never, {
      send: vi.fn(async (command: HeadObjectCommand) => {
        if (command.input.Key?.includes('/not-expired.')) throw missingObject();
        return {};
      }),
    } as never);

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('keeps empty polls and ordinary missing-object retries silent', async () => {
    const repository = {
      findNextDueAwaitingUpload: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(job('still-waiting', { uploadExpiresAt: new Date(now.getTime()) })),
      confirmUpload: vi.fn(),
      retryUploadCheck: vi.fn().mockResolvedValue(true),
      expireMissingUpload: vi.fn(),
    };
    const reconciler = new JobsReconciler(repository as never, {
      send: vi.fn().mockRejectedValue(missingObject()),
    } as never);

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(repository.retryUploadCheck).toHaveBeenCalledOnce();
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });
});
