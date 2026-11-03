import { GetObjectCommand } from '@aws-sdk/client-s3';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { WorkerService } from './worker.service.js';

const uploadId = '5e9ab819-0040-40ac-a620-e87d01c0429e';
const job = {
  uploadId, bucket: 'authoritative-bucket', key: 'incoming/authoritative.pdf', etag: 'recorded-etag', sizeBytes: 5,
  status: 'processing' as const, attempts: 1, lastSafeError: null, createdAt: new Date(), updatedAt: new Date(), leaseExpiresAt: new Date(), ownerToken: 'db-token',
};
const config = {
  databaseUrl: 'postgres://localhost/docai', queueUrl: 'main', dlqUrl: 'dlq', bucket: 'unused', pollWaitSeconds: 20,
  receiveMax: 1, visibilityTimeoutSeconds: 120, leaseMs: 120_000, heartbeatMs: 30_000, retryDelaySeconds: 1,
  retryDelayMaxSeconds: 300, awsRegion: 'us-east-1',
};

function setup(claimKind: 'claimed' | 'busy' | 'terminal' | 'missing' = 'claimed', configOverrides: Partial<typeof config> = {}) {
  const effectiveConfig = { ...config, ...configOverrides };
  const claimedJob = { ...job, leaseExpiresAt: new Date(Date.now() + effectiveConfig.leaseMs) };
  const jobs = {
    claimJob: vi.fn().mockResolvedValue(claimKind === 'claimed' ? { kind: 'claimed', job: claimedJob, ownerToken: 'fresh-owner' } : { kind: claimKind, status: 'source_checked' }),
    renewJob: vi.fn().mockResolvedValue(true), finalizeJob: vi.fn().mockResolvedValue(true),
    failJob: vi.fn().mockResolvedValue(true), releaseJob: vi.fn().mockResolvedValue(true), reconcileDeadLetter: vi.fn().mockResolvedValue(false),
  };
  const message = { Body: JSON.stringify({ uploadId, payloadVersion: 1 }), ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '1' } };
  const sqs = { send: vi.fn(async (command: unknown, _options?: { abortSignal?: AbortSignal }): Promise<unknown> => command instanceof ReceiveMessageCommand ? { Messages: [message] } : {}), destroy: vi.fn() };
  const s3 = { send: vi.fn().mockResolvedValue({ Body: (async function* () { yield Buffer.from('hello'); })() }), destroy: vi.fn() };
  const publisher = { dispatchOnce: vi.fn().mockResolvedValue({ claimed: 0, sent: 0, released: 0 }) };
  const service = new WorkerService(jobs as never, publisher as never, sqs as never, s3 as never, effectiveConfig);
  return { service, jobs, sqs, s3, message };
}

describe('worker queue consumer', () => {
  it('loads the source reference from PostgreSQL, streams with IfMatch, finalizes, then acknowledges', async () => {
    const { service, jobs, sqs, s3 } = setup();
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);

    const get = s3.send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(get.input).toMatchObject({ Bucket: job.bucket, Key: job.key, IfMatch: job.etag });
    expect(get.input.Key).not.toContain('from-message');
    expect(jobs.finalizeJob).toHaveBeenCalledWith(uploadId, expect.any(String));
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(true);
  });

  it('does not fetch or acknowledge a busy duplicate and defers its visibility', async () => {
    const { service, sqs, s3 } = setup('busy');
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(s3.send).not.toHaveBeenCalled();
    expect(sqs.send.mock.calls.some(([command]) => command instanceof ChangeMessageVisibilityCommand)).toBe(true);
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false);
  });

  it('acknowledges a terminal duplicate without fetching its source', async () => {
    const { service, jobs, sqs, s3 } = setup('terminal');
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(jobs.claimJob).toHaveBeenCalledWith(uploadId, expect.any(String), config.leaseMs);
    expect(s3.send).not.toHaveBeenCalled();
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(true);
  });

  it('defers malformed and unknown references without fetching or acknowledging', async () => {
    const malformed = setup();
    malformed.sqs.send.mockImplementationOnce(async () => ({ Messages: [{ Body: '{"key":"attacker-object"}', ReceiptHandle: 'receipt' }] } as never));
    await (malformed.service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(malformed.jobs.claimJob).not.toHaveBeenCalled();
    expect(malformed.s3.send).not.toHaveBeenCalled();
    expect(malformed.sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false);

    const unknown = setup('missing');
    await (unknown.service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(unknown.s3.send).not.toHaveBeenCalled();
    expect(unknown.sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false);
  });

  it('fails a byte-count mismatch and acknowledges only after terminal failure is durable', async () => {
    const { service, jobs, sqs, s3 } = setup();
    s3.send.mockResolvedValueOnce({ Body: (async function* () { yield Buffer.from('four'); })() });
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(jobs.failJob).toHaveBeenCalledWith(uploadId, expect.any(String), 'Uploaded PDF size does not match the confirmed upload');
    expect(jobs.finalizeJob).not.toHaveBeenCalled();
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(true);
  });

  it('permanently fails a changed ETag source', async () => {
    const { service, jobs, sqs, s3 } = setup();
    s3.send.mockRejectedValueOnce(Object.assign(new Error('condition failed'), { name: 'PreconditionFailed' }));
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(jobs.failJob).toHaveBeenCalledWith(uploadId, expect.any(String), 'Uploaded PDF is missing or changed');
    expect(jobs.releaseJob).not.toHaveBeenCalled();
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(true);
  });

  it('cancels a pending permanent-failure acknowledgement during shutdown', async () => {
    const { service, sqs, s3 } = setup();
    s3.send.mockRejectedValueOnce(Object.assign(new Error('changed'), { name: 'PreconditionFailed' }));
    let acknowledgeStarted!: () => void;
    const pendingAck = new Promise<void>((resolve) => { acknowledgeStarted = resolve; });
    sqs.send.mockImplementation(async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: JSON.stringify({ uploadId, payloadVersion: 1 }), ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '1' } }] };
      if (command instanceof DeleteMessageCommand) {
        acknowledgeStarted();
        return new Promise((resolve) => options?.abortSignal?.addEventListener('abort', () => resolve({}), { once: true }));
      }
      return {} as never;
    });
    const stopSignal = (service as unknown as { stopController: AbortController }).stopController.signal;
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(stopSignal);
    await pendingAck;
    await service.stop();
    await running;
    const deleteCall = sqs.send.mock.calls.find(([command]) => command instanceof DeleteMessageCommand);
    expect(deleteCall?.[1]).toMatchObject({ abortSignal: stopSignal });
  });

  it('stops a streamed source once it exceeds the 20 MiB limit', async () => {
    const { service, jobs, sqs, s3 } = setup();
    const chunk = Buffer.alloc(2 * 1024 * 1024);
    s3.send.mockResolvedValueOnce({ Body: (async function* () { for (let index = 0; index < 11; index += 1) yield chunk; })() });
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(jobs.failJob).toHaveBeenCalledWith(uploadId, expect.any(String), 'Uploaded PDF exceeds the allowed size');
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(true);
  });

  it('releases a real stream failure during body reading as transient', async () => {
    const { service, jobs, s3 } = setup();
    const body = new PassThrough();
    s3.send.mockResolvedValueOnce({ Body: body });
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    setTimeout(() => body.destroy(new Error('stream read failed')), 5);
    await running;
    expect(jobs.releaseJob).toHaveBeenCalledWith(uploadId, expect.any(String), 'Temporary storage validation failure');
    expect(jobs.failJob).not.toHaveBeenCalled();
  });

  it('releases transient source failures and applies a retry visibility delay', async () => {
    const { service, jobs, sqs, s3 } = setup();
    s3.send.mockRejectedValueOnce(new Error('temporary object storage failure'));
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(jobs.releaseJob).toHaveBeenCalledWith(uploadId, expect.any(String), 'Temporary storage validation failure');
    expect(sqs.send.mock.calls.some(([command]) => command instanceof ChangeMessageVisibilityCommand && command.input.VisibilityTimeout === 1)).toBe(true);
    expect(jobs.finalizeJob).not.toHaveBeenCalled();
  });

  it('aborts source reading and refuses finalization when the heartbeat loses the lease', async () => {
    const { service, jobs, sqs, s3 } = setup('claimed', { heartbeatMs: 5 });
    jobs.renewJob.mockResolvedValueOnce(false);
    s3.send.mockResolvedValueOnce({ Body: (async function* () { await new Promise((resolve) => setTimeout(resolve, 30)); yield Buffer.from('hello'); })() });
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(jobs.renewJob).toHaveBeenCalledWith(uploadId, expect.any(String), config.leaseMs);
    expect(jobs.finalizeJob).not.toHaveBeenCalled();
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false);
  });

  it('aborts source reading when SQS visibility renewal fails', async () => {
    const { service, jobs, sqs, s3 } = setup('claimed', { heartbeatMs: 5 });
    sqs.send.mockImplementation(async (command: unknown) => {
      if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: JSON.stringify({ uploadId, payloadVersion: 1 }), ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '1' } }] };
      if (command instanceof ChangeMessageVisibilityCommand) throw new Error('visibility unavailable');
      return {} as never;
    });
    s3.send.mockResolvedValueOnce({ Body: (async function* () { await new Promise((resolve) => setTimeout(resolve, 30)); yield Buffer.from('hello'); })() });
    await (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    expect(jobs.renewJob).toHaveBeenCalled();
    expect(jobs.finalizeJob).not.toHaveBeenCalled();
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false);
  });

  it('does not start a claimed job when shutdown arrives while the database claim is pending', async () => {
    const { service, jobs, s3 } = setup();
    let resolveClaim!: (value: unknown) => void;
    jobs.claimJob.mockReturnValueOnce(new Promise((resolve) => { resolveClaim = resolve; }));
    const stopSignal = (service as unknown as { stopController: AbortController }).stopController.signal;
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(stopSignal);
    await service.stop();
    resolveClaim({ kind: 'claimed', job: { ...job, leaseExpiresAt: new Date(Date.now() + config.leaseMs) }, ownerToken: 'fresh-owner' });
    await running;
    expect(s3.send).not.toHaveBeenCalled();
    expect(jobs.finalizeJob).not.toHaveBeenCalled();
  });

  it('destroys a body returned after its source signal has already aborted', async () => {
    const { service, s3 } = setup();
    const body = new PassThrough();
    s3.send.mockResolvedValueOnce({ Body: body });
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect((service as unknown as { checkSource(value: typeof job, signal: AbortSignal): Promise<number> }).checkSource(job, controller.signal)).rejects.toThrow('stopped');
    expect(body.destroyed).toBe(true);
  });

  it('closes a real readable stream after a successful source check', async () => {
    const { service, s3 } = setup();
    const body = new PassThrough();
    body.end('hello');
    s3.send.mockResolvedValueOnce({ Body: body });
    await expect((service as unknown as { checkSource(value: typeof job, signal: AbortSignal): Promise<number> }).checkSource(job, new AbortController().signal)).resolves.toBe(5);
    expect(body.destroyed).toBe(true);
  });

  it('aborts a stalled database heartbeat before the lease can expire', async () => {
    const { service, jobs, sqs, s3 } = setup('claimed', { leaseMs: 40, heartbeatMs: 5, visibilityTimeoutSeconds: 1 });
    jobs.renewJob.mockReturnValueOnce(new Promise(() => {}));
    const body = new PassThrough();
    s3.send.mockResolvedValueOnce({ Body: body });
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    await delay(80);
    await running;
    expect(jobs.renewJob).toHaveBeenCalledOnce();
    expect(body.destroyed).toBe(true);
    expect(jobs.finalizeJob).not.toHaveBeenCalled();
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false);
  });

  it('aborts a stalled SQS visibility heartbeat before the lease can expire', async () => {
    const { service, jobs, sqs, s3 } = setup('claimed', { leaseMs: 40, heartbeatMs: 5, visibilityTimeoutSeconds: 1 });
    const body = new PassThrough();
    s3.send.mockResolvedValueOnce({ Body: body });
    let heartbeatVisibilityCalls = 0;
    sqs.send.mockImplementation(async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: JSON.stringify({ uploadId, payloadVersion: 1 }), ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '1' } }] };
      if (command instanceof ChangeMessageVisibilityCommand && heartbeatVisibilityCalls++ === 0) {
        return new Promise((resolve, reject) => options?.abortSignal?.addEventListener('abort', () => reject(new Error('visibility aborted')), { once: true }));
      }
      return {} as never;
    });
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(new AbortController().signal);
    await delay(80);
    await running;
    expect(jobs.renewJob).toHaveBeenCalledOnce();
    expect(body.destroyed).toBe(true);
    expect(jobs.finalizeJob).not.toHaveBeenCalled();
  });

  it('does not send or arm timers when a database heartbeat resolves after shutdown', async () => {
    const { service, jobs, sqs, s3 } = setup('claimed', { heartbeatMs: 5 });
    const body = new PassThrough();
    s3.send.mockResolvedValueOnce({ Body: body });
    let renewStarted!: () => void;
    const started = new Promise<void>((resolve) => { renewStarted = resolve; });
    let resolveRenew!: (value: boolean) => void;
    jobs.renewJob.mockImplementationOnce(() => {
      renewStarted();
      return new Promise<boolean>((resolve) => { resolveRenew = resolve; });
    });
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const stopSignal = (service as unknown as { stopController: AbortController }).stopController.signal;
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(stopSignal);
    await started;
    const watchdogTimer = timerSpy.mock.results.at(-1)?.value;
    await service.stop();
    await running;
    service.closeClients();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(watchdogTimer);
    expect(body.destroyed).toBe(true);
    const sendsAfterClose = sqs.send.mock.calls.length;
    const timersAfterClose = timerSpy.mock.calls.length;
    resolveRenew(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(sqs.send).toHaveBeenCalledTimes(sendsAfterClose);
    expect(timerSpy).toHaveBeenCalledTimes(timersAfterClose);
    timerSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('ignores a late database heartbeat rejection after shutdown without logging or rearming timers', async () => {
    const { service, jobs, sqs, s3 } = setup('claimed', { heartbeatMs: 5 });
    const body = new PassThrough();
    s3.send.mockResolvedValueOnce({ Body: body });
    let renewStarted!: () => void;
    const started = new Promise<void>((resolve) => { renewStarted = resolve; });
    let rejectRenew!: (error: Error) => void;
    jobs.renewJob.mockImplementationOnce(() => {
      renewStarted();
      return new Promise<boolean>((_resolve, reject) => { rejectRenew = reject; });
    });
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const stopSignal = (service as unknown as { stopController: AbortController }).stopController.signal;
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(stopSignal);
    await started;
    await service.stop();
    await running;
    service.closeClients();
    const sendsAfterClose = sqs.send.mock.calls.length;
    const timersAfterClose = timerSpy.mock.calls.length;
    rejectRenew(new Error('late database failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(sqs.send).toHaveBeenCalledTimes(sendsAfterClose);
    expect(timerSpy).toHaveBeenCalledTimes(timersAfterClose);
    timerSpy.mockRestore();
  });

  it('ignores a late SQS visibility completion after shutdown without rearming timers', async () => {
    const { service, jobs, sqs, s3 } = setup('claimed', { heartbeatMs: 5 });
    const body = new PassThrough();
    s3.send.mockResolvedValueOnce({ Body: body });
    let visibilityStarted!: () => void;
    const started = new Promise<void>((resolve) => { visibilityStarted = resolve; });
    let resolveVisibility!: (value: unknown) => void;
    sqs.send.mockImplementation(async (command: unknown) => {
      if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: JSON.stringify({ uploadId, payloadVersion: 1 }), ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '1' } }] };
      if (command instanceof ChangeMessageVisibilityCommand) {
        visibilityStarted();
        return new Promise((resolve) => { resolveVisibility = resolve; });
      }
      return {} as never;
    });
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const stopSignal = (service as unknown as { stopController: AbortController }).stopController.signal;
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(stopSignal);
    await started;
    await service.stop();
    await running;
    service.closeClients();
    const sendsAfterClose = sqs.send.mock.calls.length;
    const timersAfterClose = timerSpy.mock.calls.length;
    resolveVisibility({});
    await Promise.resolve();
    await Promise.resolve();
    expect(jobs.renewJob).toHaveBeenCalledOnce();
    expect(sqs.send).toHaveBeenCalledTimes(sendsAfterClose);
    expect(timerSpy).toHaveBeenCalledTimes(timersAfterClose);
    timerSpy.mockRestore();
  });

  it('ignores a late SQS visibility rejection after shutdown without logging or rearming timers', async () => {
    const { service, sqs, s3 } = setup('claimed', { heartbeatMs: 5 });
    const body = new PassThrough();
    s3.send.mockResolvedValueOnce({ Body: body });
    let visibilityStarted!: () => void;
    const started = new Promise<void>((resolve) => { visibilityStarted = resolve; });
    let rejectVisibility!: (error: Error) => void;
    sqs.send.mockImplementation(async (command: unknown) => {
      if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: JSON.stringify({ uploadId, payloadVersion: 1 }), ReceiptHandle: 'receipt', Attributes: { ApproximateReceiveCount: '1' } }] };
      if (command instanceof ChangeMessageVisibilityCommand) {
        visibilityStarted();
        return new Promise((_resolve, reject) => { rejectVisibility = reject; });
      }
      return {} as never;
    });
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const stopSignal = (service as unknown as { stopController: AbortController }).stopController.signal;
    const running = (service as unknown as { consumeOne(signal: AbortSignal): Promise<void> }).consumeOne(stopSignal);
    await started;
    await service.stop();
    await running;
    service.closeClients();
    const sendsAfterClose = sqs.send.mock.calls.length;
    const timersAfterClose = timerSpy.mock.calls.length;
    rejectVisibility(new Error('late visibility failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(sqs.send).toHaveBeenCalledTimes(sendsAfterClose);
    expect(timerSpy).toHaveBeenCalledTimes(timersAfterClose);
    timerSpy.mockRestore();
  });

  it('retains a DLQ message and defers it without deleting it', async () => {
    const { service, jobs, sqs } = setup();
    await (service as unknown as { reconcileOne(signal: AbortSignal): Promise<void> }).reconcileOne(new AbortController().signal);
    expect(jobs.reconcileDeadLetter).toHaveBeenCalledWith(uploadId, 'Upload job exceeded retry limit');
    expect(sqs.send.mock.calls.some(([command]) => command instanceof ChangeMessageVisibilityCommand && command.input.QueueUrl === config.dlqUrl && command.input.VisibilityTimeout === 300)).toBe(true);
    expect(sqs.send.mock.calls.some(([command]) => command instanceof DeleteMessageCommand)).toBe(false);
  });

  it('cancels a pending DLQ visibility deferral during shutdown', async () => {
    const { service, sqs } = setup();
    let deferStarted!: () => void;
    const pendingDefer = new Promise<void>((resolve) => { deferStarted = resolve; });
    sqs.send.mockImplementation(async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: JSON.stringify({ uploadId, payloadVersion: 1 }), ReceiptHandle: 'receipt' }] };
      if (command instanceof ChangeMessageVisibilityCommand) {
        deferStarted();
        return new Promise((resolve) => options?.abortSignal?.addEventListener('abort', () => resolve({}), { once: true }));
      }
      return {} as never;
    });
    const stopSignal = (service as unknown as { stopController: AbortController }).stopController.signal;
    const running = (service as unknown as { reconcileOne(signal: AbortSignal): Promise<void> }).reconcileOne(stopSignal);
    await pendingDefer;
    await service.stop();
    await running;
    const visibilityCall = sqs.send.mock.calls.find(([command]) => command instanceof ChangeMessageVisibilityCommand);
    expect(visibilityCall?.[1]).toMatchObject({ abortSignal: stopSignal });
  });
});
