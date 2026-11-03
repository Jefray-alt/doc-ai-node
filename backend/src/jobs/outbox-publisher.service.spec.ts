import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutboxPublisherService, createOutboxSqsClient } from './outbox-publisher.service.js';

const message = {
  uploadId: '5e9ab819-0040-40ac-a620-e87d01c0429e',
  payloadVersion: 1 as const,
  bucket: 'internal-bucket',
  key: 'incoming/file.pdf',
  etag: 'private-etag',
  sizeBytes: 123,
  ownerToken: 'owner-token',
};

function setup() {
  const jobs = {
    claimOutbox: vi.fn().mockResolvedValue([message]),
    markOutboxSent: vi.fn().mockResolvedValue(true),
    releaseOutbox: vi.fn().mockResolvedValue(true),
  };
  const sqs = { send: vi.fn().mockResolvedValue({ MessageId: 'message-id' }) };
  const publisher = new OutboxPublisherService(jobs as never, sqs as never, {
    queueUrl: 'http://localhost:4566/000000000000/test-queue',
    batchSize: 10,
    leaseMs: 30_000,
  });
  return { jobs, sqs, publisher };
}

describe('outbox publisher', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('sends only the upload reference then marks the outbox row sent', async () => {
    const { jobs, sqs, publisher } = setup();

    await expect(publisher.dispatchOnce()).resolves.toMatchObject({ claimed: 1, sent: 1, released: 0 });
    const command = sqs.send.mock.calls[0]?.[0] as SendMessageCommand;
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input).toMatchObject({
      QueueUrl: 'http://localhost:4566/000000000000/test-queue',
      DelaySeconds: 0,
      MessageBody: JSON.stringify({ uploadId: message.uploadId, payloadVersion: 1 }),
    });
    expect(command.input.MessageBody).not.toContain(message.bucket);
    expect(command.input.MessageBody).not.toContain(message.key);
    expect(command.input.MessageBody).not.toContain(message.etag);
    expect(jobs.markOutboxSent).toHaveBeenCalledWith(message.uploadId, message.ownerToken);
    expect(jobs.releaseOutbox).not.toHaveBeenCalled();
  });

  it('releases a claimed row after SQS rejects it so the next dispatch can retry', async () => {
    const { jobs, sqs, publisher } = setup();
    sqs.send.mockRejectedValueOnce(new Error('credential secret should not be persisted'));

    await expect(publisher.dispatchOnce()).resolves.toMatchObject({ claimed: 1, sent: 0, released: 1 });
    expect(jobs.releaseOutbox).toHaveBeenCalledWith(message.uploadId, message.ownerToken, 'queue delivery failed');
    expect(jobs.markOutboxSent).not.toHaveBeenCalled();

    await expect(publisher.dispatchOnce()).resolves.toMatchObject({ claimed: 1, sent: 1, released: 0 });
    expect(sqs.send).toHaveBeenCalledTimes(2);
    expect(jobs.markOutboxSent).toHaveBeenCalledWith(message.uploadId, message.ownerToken);
  });

  it('allows a duplicate SQS send after an acknowledgement failure and lease recovery', async () => {
    const { jobs, sqs, publisher } = setup();
    jobs.markOutboxSent.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(publisher.dispatchOnce()).rejects.toThrow('database unavailable');
    expect(sqs.send).toHaveBeenCalledTimes(1);
    expect(jobs.releaseOutbox).not.toHaveBeenCalled();

    jobs.claimOutbox.mockResolvedValueOnce([{ ...message, ownerToken: 'recovered-owner' }]);
    await expect(publisher.dispatchOnce()).resolves.toMatchObject({ claimed: 1, sent: 1, released: 0 });
    expect(sqs.send).toHaveBeenCalledTimes(2);
    expect(jobs.markOutboxSent).toHaveBeenLastCalledWith(message.uploadId, 'recovered-owner');
  });

  it('requires a queue URL when constructed', () => {
    const jobs = { claimOutbox: vi.fn(), markOutboxSent: vi.fn(), releaseOutbox: vi.fn() };
    expect(() => new OutboxPublisherService(jobs as never, { send: vi.fn() } as never, { queueUrl: '' })).toThrow(/SQS queue URL/);
  });

  it('passes temporary AWS session credentials to the SQS client', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'temporary-access');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'temporary-secret');
    vi.stubEnv('AWS_SESSION_TOKEN', 'temporary-session-token');
    const client = createOutboxSqsClient();
    try {
      await expect(client.config.credentials()).resolves.toMatchObject({ sessionToken: 'temporary-session-token' });
    } finally {
      client.destroy();
    }
  });
});
