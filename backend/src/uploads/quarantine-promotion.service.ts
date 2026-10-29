import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { CopyObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CopyObjectCommandOutput, HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { S3_CLIENT, S3_STORAGE_CONFIG } from '../storage/s3-storage.module.js';
import type { S3StorageConfig } from '../storage/s3-storage.config.js';

export interface PromoteQuarantinedUploadInput {
  uploadId: string;
  sourceKey: string;
  versionId: string;
  etag: string;
  signal?: AbortSignal;
}

export interface QuarantinePromotionResult {
  status: 'promoted' | 'already-promoted';
  bucket: string;
  key: string;
  destinationVersionId?: string;
}

@Injectable()
export class QuarantinePromotionService {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(S3_STORAGE_CONFIG) private readonly config: S3StorageConfig,
  ) {}

  async promote(input: PromoteQuarantinedUploadInput): Promise<QuarantinePromotionResult> {
    this.validate(input);
    const destinationKey = this.destinationKey(input.uploadId, input.versionId);
    const existing = await this.findExisting(input, destinationKey);
    if (existing) return existing;

    const source = `${this.config.quarantineBucket}/${this.encodeKey(input.sourceKey)}?versionId=${encodeURIComponent(input.versionId)}`;
    try {
      const response = await this.send<CopyObjectCommandOutput>(new CopyObjectCommand({
        Bucket: this.config.cleanBucket,
        Key: destinationKey,
        CopySource: source,
        CopySourceIfMatch: input.etag,
        IfNoneMatch: '*',
        MetadataDirective: 'REPLACE',
        ContentType: 'application/pdf',
        Metadata: {
          'source-bucket': this.config.quarantineBucket,
          'source-key': input.sourceKey,
          'source-version-id': input.versionId,
          'source-etag': input.etag,
          'upload-id': input.uploadId,
        },
      }), input.signal);
      return {
        status: 'promoted',
        bucket: this.config.cleanBucket,
        key: destinationKey,
        ...(response.VersionId ? { destinationVersionId: response.VersionId } : {}),
      };
    } catch (error) {
      if (this.isConditionalConflict(error)) {
        const winner = await this.findExisting(input, destinationKey);
        if (winner) return winner;
      }
      throw error;
    }
  }

  private validate(input: PromoteQuarantinedUploadInput): void {
    if (!input.versionId?.trim() || input.versionId.trim().toLowerCase() === 'null') {
      throw new Error('A non-null S3 version ID is required for quarantine promotion');
    }
    if (!input.etag?.trim()) throw new Error('An ETag is required for quarantine promotion');
    if (!input.uploadId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.uploadId)) {
      throw new Error('A UUID upload ID is required for quarantine promotion');
    }
    if (input.sourceKey !== `incoming/${input.uploadId}.pdf`) {
      throw new Error('The quarantine object key does not match the upload ID');
    }
  }

  private destinationKey(uploadId: string, versionId: string): string {
    const digest = createHash('sha256').update(versionId).digest('hex');
    return `cleared/${uploadId}/${digest}.pdf`;
  }

  private encodeKey(key: string): string {
    return key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  }

  private async findExisting(
    input: PromoteQuarantinedUploadInput,
    key: string,
  ): Promise<QuarantinePromotionResult | undefined> {
    let head: HeadObjectCommandOutput;
    try {
      head = await this.send(new HeadObjectCommand({ Bucket: this.config.cleanBucket, Key: key }), input.signal);
    } catch (error) {
      if (this.isNotFound(error)) return undefined;
      throw error;
    }

    const metadata = head.Metadata ?? {};
    const matches = metadata['source-bucket'] === this.config.quarantineBucket
      && metadata['source-key'] === input.sourceKey
      && metadata['source-version-id'] === input.versionId
      && metadata['source-etag'] === input.etag
      && metadata['upload-id'] === input.uploadId;
    if (!matches) {
      throw new ConflictException('A different quarantine object version already occupies the clean destination');
    }
    return {
      status: 'already-promoted',
      bucket: this.config.cleanBucket,
      key,
      ...(head.VersionId ? { destinationVersionId: head.VersionId } : {}),
    };
  }

  private send<T>(command: HeadObjectCommand | CopyObjectCommand, signal?: AbortSignal): Promise<T> {
    const options = signal ? { abortSignal: signal } : undefined;
    return this.s3.send(command as never, options) as Promise<T>;
  }

  private isNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return candidate.name === 'NotFound' || candidate.name === 'NoSuchKey' || candidate.$metadata?.httpStatusCode === 404;
  }

  private isConditionalConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    return candidate.name === 'PreconditionFailed'
      || candidate.name === 'ConditionalRequestConflict'
      || candidate.$metadata?.httpStatusCode === 409
      || candidate.$metadata?.httpStatusCode === 412;
  }
}
