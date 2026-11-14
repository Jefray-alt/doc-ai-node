import { Injectable } from '@nestjs/common';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { MAX_UPLOAD_BYTES } from '../uploads/uploads.constants.js';
import {
  PdfExtractionError,
  PdfInputVerificationError,
  PdfPageLimitError,
} from './pdf-extractor.errors.js';
import type { PdfPageConsumer } from './pdf-extractor.types.js';
export { PdfExtractionError, PdfInputVerificationError, PdfPageLimitError } from './pdf-extractor.errors.js';
export type { PdfPageConsumer, PdfPageText } from './pdf-extractor.types.js';

const MAX_PDF_PAGES = 100;

function normalizeParserError(error: unknown): PdfExtractionError {
  if (error instanceof PdfExtractionError) {
    return error;
  }

  const name = error instanceof Error ? error.name : undefined;

  if (name === 'PasswordException') {
    return new PdfExtractionError('PDF_PASSWORD_REQUIRED');
  }

  if (name === 'InvalidPDFException' || name === 'FormatError') {
    return new PdfExtractionError('PDF_MALFORMED');
  }

  throw error;
}

@Injectable()
export class PdfExtractor {
  async extract(bytes: Uint8Array, consumer: PdfPageConsumer): Promise<void> {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new PdfInputVerificationError('PDF_TOO_LARGE');
    }

    if (bytes.byteLength < 5 || ![0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, index) => bytes[index] === byte)) {
      throw new PdfInputVerificationError('PDF_INVALID_HEADER');
    }

    let loadingTask: pdfjs.PDFDocumentLoadingTask | undefined;
    let document: pdfjs.PDFDocumentProxy | undefined;
    let hasText = false;

    try {
      try {
        loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: false });
        document = await loadingTask.promise;
      } catch (error) {
        throw normalizeParserError(error);
      }

      if (document.numPages > MAX_PDF_PAGES) {
        throw new PdfPageLimitError(MAX_PDF_PAGES);
      }

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        let page: pdfjs.PDFPageProxy | undefined;
        let text: string;

        try {
          page = await document.getPage(pageNumber);
          const content = await page.getTextContent();
          const textItems = content.items.filter((item) => 'str' in item);
          text = textItems.reduce((result, item, index) => {
            const separator = index > 0 && !textItems[index - 1]?.hasEOL ? ' ' : '';
            return `${result}${separator}${item.str}${item.hasEOL ? '\n' : ''}`;
          }, '');
        } catch (error) {
          try {
            page?.cleanup();
          } catch {
            // Preserve the parser failure if page cleanup fails.
          }
          throw normalizeParserError(error);
        }

        hasText ||= text.trim().length > 0;

        try {
          await consumer({ pageNumber, text });
        } finally {
          try {
            page.cleanup();
          } catch {
            // Preserve the parse or consumer failure if page cleanup fails.
          }
        }
      }

      if (!hasText) {
        throw new PdfExtractionError('PDF_NO_TEXT');
      }
    } finally {
      try {
        if (document) {
          await document.cleanup();
        }
      } catch {
        // Preserve the parse or consumer failure if cleanup itself fails.
      }

      try {
        await loadingTask?.destroy();
      } catch {
        // Preserve the parse or consumer failure if cleanup itself fails.
      }
    }
  }
}
