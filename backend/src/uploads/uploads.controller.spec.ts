import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

describe('upload job HTTP endpoints', () => {
  let app: INestApplication;
  const uploads = {
    completeUpload: vi.fn(),
    getUploadStatus: vi.fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [{ provide: UploadsService, useValue: uploads }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('confirms a generated upload and returns accepted status', async () => {
    const uploadId = '5e9ab819-0040-40ac-a620-e87d01c0429e';
    uploads.completeUpload.mockResolvedValueOnce({ uploadId, status: 'queued', updatedAt: '2026-01-01T00:00:00.000Z', error: null });

    await request(app.getHttpServer()).post(`/uploads/${uploadId}/complete`).expect(202).expect({
      uploadId,
      status: 'queued',
      updatedAt: '2026-01-01T00:00:00.000Z',
      error: null,
    });
    expect(uploads.completeUpload).toHaveBeenCalledWith(uploadId);
  });

  it('validates UUIDs before looking up an upload', async () => {
    await request(app.getHttpServer()).post('/uploads/not-a-uuid/complete').expect(400);
    await request(app.getHttpServer()).get('/uploads/not-a-uuid/status').expect(400);
    expect(uploads.completeUpload).not.toHaveBeenCalled();
    expect(uploads.getUploadStatus).not.toHaveBeenCalled();
  });

  it('returns only public status fields', async () => {
    const uploadId = 'bb1bbcca-ae13-4b7b-a0a5-53678c0a9a7a';
    uploads.getUploadStatus.mockResolvedValueOnce({ uploadId, status: 'failed', updatedAt: '2026-01-02T00:00:00.000Z', error: 'source unavailable' });

    await request(app.getHttpServer()).get(`/uploads/${uploadId}/status`).expect(200).expect({
      uploadId,
      status: 'failed',
      updatedAt: '2026-01-02T00:00:00.000Z',
      error: 'source unavailable',
    });
    expect(uploads.getUploadStatus).toHaveBeenCalledWith(uploadId);
  });

  it('returns 404 for an unknown status ID', async () => {
    const uploadId = 'd4700df7-4d76-44ec-91f0-aac34a33ee40';
    uploads.getUploadStatus.mockRejectedValueOnce(new NotFoundException('Upload was not found'));
    await request(app.getHttpServer()).get(`/uploads/${uploadId}/status`).expect(404);
  });
});
