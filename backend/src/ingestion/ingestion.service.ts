import { Injectable } from '@nestjs/common';
import { PdfDownloader } from './pdf-downloader.ts';
import { PdfExtractor } from './pdf-extractor.ts';
import type { PdfPageConsumer } from './pdf-extractor.types.ts';

@Injectable()
export class IngestionService {
  constructor(
    private readonly downloader: PdfDownloader,
    private readonly extractor: PdfExtractor,
  ) {}

  async extract(bucket: string, key: string, consumer: PdfPageConsumer, signal?: AbortSignal): Promise<void> {
    const bytes = await this.downloader.download(bucket, key, signal);
    await this.extractor.extract(bytes, consumer);
  }
}
