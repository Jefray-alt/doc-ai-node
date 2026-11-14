import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { MAX_UPLOAD_BYTES } from '../uploads/uploads.constants.js';
import { DownloadTooLargeError } from './pdf-downloader.errors.js';
export { DownloadTooLargeError } from './pdf-downloader.errors.js';

const DOWNLOAD_TIMEOUT_MS = 30_000;

type DownloadBody = AsyncIterable<Uint8Array> & {
  destroy?: (error?: Error) => void;
};

@Injectable()
export class PdfDownloader {
  constructor(private readonly s3: S3Client) {}

  async download(bucket: string, key: string, callerSignal?: AbortSignal): Promise<Uint8Array> {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new Error('PDF download aborted');
    }

    const controller = new AbortController();
    let body: DownloadBody | undefined;
    const destroyBody = () => {
      if (body?.destroy) {
        body.destroy();
      }
    };
    const abort = (reason: unknown) => {
      controller.abort(reason);
      destroyBody();
    };
    const timeout = setTimeout(() => {
      abort(new Error(`PDF download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`));
    }, DOWNLOAD_TIMEOUT_MS);
    const onCallerAbort = () => abort(callerSignal?.reason ?? new Error('PDF download aborted'));

    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: controller.signal },
      );

      body = response.Body as DownloadBody | undefined;

      if (controller.signal.aborted) {
        destroyBody();
        throw controller.signal.reason;
      }

      if (response.ContentLength !== undefined && response.ContentLength > MAX_UPLOAD_BYTES) {
        destroyBody();
        throw new DownloadTooLargeError(MAX_UPLOAD_BYTES, response.ContentLength);
      }

      if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
        throw new Error('S3 returned no readable PDF body');
      }

      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;

      for await (const chunk of body) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_UPLOAD_BYTES) {
          destroyBody();
          throw new DownloadTooLargeError(MAX_UPLOAD_BYTES, receivedBytes);
        }

        chunks.push(chunk);
      }

      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      const result = new Uint8Array(receivedBytes);
      let offset = 0;

      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return result;
    } catch (error) {
      destroyBody();
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
