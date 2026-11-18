import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsRepository } from './jobs.repository.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function setup() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    release: vi.fn(),
    connection: { stream: { destroy: vi.fn() } },
  });
  const pool = { connect: vi.fn((callback: (error?: Error, acquired?: typeof client) => void) => {
    callback(undefined, client);
  }) };
  return { client, pool, repository: new JobsRepository(pool as never) };
}

describe('bounded claim renewal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns acceptance only after commit, then returns the clean connection', async () => {
    const { client, repository } = setup();
    const commit = deferred<{ rowCount: number }>();
    client.query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rowCount: 1 }).mockReturnValueOnce(commit.promise);
    let finished = false;
    const renewal = repository.renewClaim('job', 'token', 'uploaded').then((value) => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(client.release).not.toHaveBeenCalled();
    commit.resolve({ rowCount: 0 });
    await expect(renewal).resolves.toBe(true);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not issue SQL for an acquisition returned after the entire request deadline', async () => {
    const { client, pool, repository } = setup();
    let finishAcquisition!: (error?: Error, acquired?: typeof client) => void;
    pool.connect.mockImplementationOnce((callback) => { finishAcquisition = callback; });
    const renewal = repository.renewClaim('job', 'token', 'uploaded');
    const rejected = expect(renewal).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    finishAcquisition(undefined, client);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1, 2])('disposes a timed-out connection during SQL phase %s without queued cleanup SQL', async (phase) => {
    const { client, repository } = setup();
    const stalled = deferred<{ rowCount: number }>();
    for (let index = 0; index < phase; index++) client.query.mockResolvedValueOnce({ rowCount: 1 });
    client.query.mockReturnValueOnce(stalled.promise);
    const renewal = repository.renewClaim('job', 'token', 'uploaded');
    const rejected = expect(renewal).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(client.connection.stream.destroy).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    stalled.resolve({ rowCount: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.query).toHaveBeenCalledTimes(phase + 1);
    expect(client.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1, 2])('rejects client errors in SQL phase %s, disposes once, and never starts later SQL', async (phase) => {
    const { client, repository } = setup();
    const stalled = deferred<{ rowCount: number }>();
    for (let index = 0; index < phase; index++) client.query.mockResolvedValueOnce({ rowCount: 1 });
    client.query.mockReturnValueOnce(stalled.promise);
    client.release.mockImplementation(() => {
      expect(client.listenerCount('error')).toBe(1);
    });
    const renewal = repository.renewClaim('job', 'token', 'uploaded');
    const rejected = expect(renewal).rejects.toThrow('socket failed');
    await vi.advanceTimersByTimeAsync(0);
    client.emit('error', new Error('socket failed'));
    await rejected;
    stalled.resolve({ rowCount: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.query).toHaveBeenCalledTimes(phase + 1);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.connection.stream.destroy).toHaveBeenCalledOnce();
    expect(client.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('protects checkout before the promise continuation and hands successful clients back without a listener gap', async () => {
    const { client, pool, repository } = setup();
    pool.connect.mockImplementationOnce((callback) => {
      callback(undefined, client);
      client.emit('error', new Error('checkout socket failed'));
    });
    await expect(repository.renewClaim('job', 'token', 'uploaded')).rejects.toThrow('checkout socket failed');
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount('error')).toBe(0);
    client.release.mockImplementation(() => {
      expect(client.listenerCount('error')).toBe(1);
    });
    await expect(repository.renewClaim('job', 'token', 'uploaded')).resolves.toBe(true);
    expect(client.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes an errored transaction and reports rejection or zero-row ownership faithfully', async () => {
    const { client, repository } = setup();
    client.query.mockResolvedValueOnce({ rowCount: 0 }).mockRejectedValueOnce(new Error('lost connection'));
    await expect(repository.renewClaim('job', 'token', 'uploaded')).rejects.toThrow('lost connection');
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    client.query.mockResolvedValue({ rowCount: 0 });
    await expect(repository.renewClaim('job', 'token', 'uploaded')).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
