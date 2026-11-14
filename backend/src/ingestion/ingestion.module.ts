import { Module } from '@nestjs/common';
import { S3Module } from '../storage/s3.module.ts';
import { IngestionService } from './ingestion.service.ts';
import { PdfDownloader } from './pdf-downloader.ts';
import { PdfExtractor } from './pdf-extractor.ts';

@Module({
  imports: [S3Module],
  providers: [PdfDownloader, PdfExtractor, IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
