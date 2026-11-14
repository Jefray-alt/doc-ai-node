import { Module } from '@nestjs/common';
import { S3Module } from '../storage/s3.module.js';
import { IngestionService } from './ingestion.service.js';
import { PdfDownloader } from './pdf-downloader.js';
import { PdfExtractor } from './pdf-extractor.js';

@Module({
  imports: [S3Module],
  providers: [PdfDownloader, PdfExtractor, IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
