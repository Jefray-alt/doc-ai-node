import { describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { QuarantinePromotionService } from './quarantine-promotion.service.js';
import type { S3StorageConfig } from '../storage/s3-storage.config.js';

describe('QuarantinePromotionService', () => {
  const config: S3StorageConfig = {
    region: 'us-east-1',
    quarantineBucket: 'quarantine',
    cleanBucket: 'clean',
  };

  it('copies the exact version with ETag and no-overwrite conditions, recording provenance', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }))
      .mockResolvedValueOnce({ CopySourceVersionId: 'source-version-1', VersionId: 'clean-version-1' });
    const s3 = { send } as unknown as S3Client;
    const service = new QuarantinePromotionService(s3, config);
    const signal = new AbortController().signal;

    const result = await service.promote({
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      sourceKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'version/one',
      etag: '"etag-123"',
      signal,
    });

    expect(result).toEqual({
      status: 'promoted',
      bucket: 'clean',
      key: 'cleared/123e4567-e89b-42d3-a456-426614174000/328f52fad1dd6d4c6ec148a7f1c3095906983177ae718eff146c817f8d6e1edc.pdf',
      destinationVersionId: 'clean-version-1',
    });
    expect(send).toHaveBeenNthCalledWith(1, expect.any(HeadObjectCommand), { abortSignal: signal });
    const copy = send.mock.calls[1]?.[0] as CopyObjectCommand;
    expect(copy.input).toMatchObject({
      Bucket: 'clean',
      Key: result.key,
      CopySource: 'quarantine/incoming/123e4567-e89b-42d3-a456-426614174000.pdf?versionId=version%2Fone',
      CopySourceIfMatch: '"etag-123"',
      IfNoneMatch: '*',
      MetadataDirective: 'REPLACE',
      Metadata: {
        'source-bucket': 'quarantine',
        'source-key': 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
        'source-version-id': 'version/one',
        'source-etag': '"etag-123"',
        'upload-id': '123e4567-e89b-42d3-a456-426614174000',
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, expect.any(CopyObjectCommand), { abortSignal: signal });
  });

  it('omits the destination version when the clean bucket is unversioned', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }))
      .mockResolvedValueOnce({ CopySourceVersionId: 'source-version-1' });
    const service = new QuarantinePromotionService({ send } as unknown as S3Client, config);

    const result = await service.promote({
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      sourceKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'version-1',
      etag: 'etag-1',
    });

    expect(result).toMatchObject({ status: 'promoted', bucket: 'clean' });
    expect(result).not.toHaveProperty('destinationVersionId');
    expect(result).not.toHaveProperty('versionId');
  });

  it('returns already-promoted only when destination provenance matches', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Metadata: {
        'source-bucket': 'quarantine',
        'source-key': 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
        'source-version-id': 'version-1',
        'source-etag': 'etag-1',
        'upload-id': '123e4567-e89b-42d3-a456-426614174000',
      },
      VersionId: 'clean-version-1',
    });
    const service = new QuarantinePromotionService({ send } as unknown as S3Client, config);

    await expect(service.promote({
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      sourceKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'version-1',
      etag: 'etag-1',
    })).resolves.toMatchObject({ status: 'already-promoted', destinationVersionId: 'clean-version-1' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('converges when another worker creates the same destination during the conditional copy', async () => {
    const provenance = {
      'source-bucket': 'quarantine',
      'source-key': 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      'source-version-id': 'version-1',
      'source-etag': 'etag-1',
      'upload-id': '123e4567-e89b-42d3-a456-426614174000',
    };
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }))
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }))
      .mockResolvedValueOnce({ Metadata: provenance, VersionId: 'clean-version-1' });
    const service = new QuarantinePromotionService({ send } as unknown as S3Client, config);

    await expect(service.promote({
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      sourceKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'version-1',
      etag: 'etag-1',
    })).resolves.toMatchObject({ status: 'already-promoted', destinationVersionId: 'clean-version-1' });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(CopyObjectCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('fails rather than overwriting a destination with different provenance', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Metadata: {
        'source-bucket': 'quarantine',
        'source-key': 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
        'source-version-id': 'a-different-version',
        'source-etag': 'etag-1',
        'upload-id': '123e4567-e89b-42d3-a456-426614174000',
      },
    });
    const service = new QuarantinePromotionService({ send } as unknown as S3Client, config);

    await expect(service.promote({
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      sourceKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'version-1',
      etag: 'etag-1',
    })).rejects.toThrow(/different quarantine object version/i);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('fails if the destination is claimed by different provenance during a concurrent copy', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }))
      .mockRejectedValueOnce(Object.assign(new Error('exists'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }))
      .mockResolvedValueOnce({
        Metadata: {
          'source-bucket': 'quarantine',
          'source-key': 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
          'source-version-id': 'other-version',
          'source-etag': 'etag-1',
          'upload-id': '123e4567-e89b-42d3-a456-426614174000',
        },
      });
    const service = new QuarantinePromotionService({ send } as unknown as S3Client, config);

    await expect(service.promote({
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      sourceKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'version-1',
      etag: 'etag-1',
    })).rejects.toThrow(/different quarantine object version/i);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('rejects missing or null version IDs before touching S3', async () => {
    const send = vi.fn();
    const service = new QuarantinePromotionService({ send } as unknown as S3Client, config);

    await expect(service.promote({
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      sourceKey: 'incoming/123e4567-e89b-42d3-a456-426614174000.pdf',
      versionId: 'null',
      etag: 'etag-1',
    })).rejects.toThrow(/version/i);
    expect(send).not.toHaveBeenCalled();
  });
});
