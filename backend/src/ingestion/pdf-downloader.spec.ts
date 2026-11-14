import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../uploads/uploads.constants.ts';
import { DownloadTooLargeError, PdfDownloader } from './pdf-downloader.ts';

function makeDownloader(body: Readable, contentLength?: number) {
  const send = vi.fn().mockResolvedValue({ Body: body, ContentLength: contentLength });
  const s3 = { send } as unknown as S3Client;

  return { downloader: new PdfDownloader(s3), send };
}

afterEach(() => vi.useRealTimers());

describe('PdfDownloader', () => {
  it('collects all object chunks in order and requests the selected key', async () => {
    const body = Readable.from([Buffer.from('pdf '), Buffer.from('bytes')]);
    const { downloader, send } = makeDownloader(body, 9);

    await expect(downloader.download('documents', 'one.pdf')).resolves.toEqual(
      new Uint8Array(Buffer.from('pdf bytes')),
    );
    expect(send).toHaveBeenCalledWith(expect.any(GetObjectCommand), expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
    expect(send.mock.calls[0]?.[0].input).toMatchObject({ Bucket: 'documents', Key: 'one.pdf' });
  });

  it('rejects an advertised object larger than the upload cap and destroys its body', async () => {
    const body = Readable.from([]);
    const destroy = vi.spyOn(body, 'destroy');
    const { downloader } = makeDownloader(body, MAX_UPLOAD_BYTES + 1);

    await expect(downloader.download('documents', 'large.pdf')).rejects.toBeInstanceOf(DownloadTooLargeError);
    expect(destroy).toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['misleading', 1],
  ])('enforces the actual byte cap when ContentLength is %s', async (_label, contentLength) => {
    const body = Readable.from([Buffer.alloc(MAX_UPLOAD_BYTES), Buffer.from([1])]);
    const { downloader } = makeDownloader(body, contentLength);

    await expect(downloader.download('documents', 'large.pdf')).rejects.toBeInstanceOf(DownloadTooLargeError);
  });

  it('times out while waiting for the complete object body and cleans it up', async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    const destroy = vi.spyOn(body, 'destroy');
    const { downloader } = makeDownloader(body, 0);
    const pending = downloader.download('documents', 'stalled.pdf');
    const rejected = expect(pending).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(destroy).toHaveBeenCalled();
  });

  it('aborts an in-progress body when the caller signal fires', async () => {
    const body = new Readable({ read() {} });
    const destroy = vi.spyOn(body, 'destroy');
    const { downloader } = makeDownloader(body, 0);
    const caller = new AbortController();
    const pending = downloader.download('documents', 'cancelled.pdf', caller.signal);
    const rejected = expect(pending).rejects.toThrow('caller cancelled');

    caller.abort(new Error('caller cancelled'));

    await rejected;
    expect(destroy).toHaveBeenCalled();
  });
});
