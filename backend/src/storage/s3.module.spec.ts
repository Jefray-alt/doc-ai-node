import { Test } from '@nestjs/testing';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { S3Module } from './s3.module.js';

describe('S3Module', () => {
  it('destroys the registered client once during application shutdown', async () => {
    const destroy = vi.fn();
    const client = { destroy } as unknown as S3Client;
    const testingModule = await Test.createTestingModule({ imports: [S3Module] })
      .overrideProvider(S3Client)
      .useValue(client)
      .compile();
    const app = testingModule.createNestApplication();

    await app.init();
    await app.close();

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
