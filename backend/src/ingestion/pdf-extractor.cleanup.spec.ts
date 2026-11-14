import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfExtractor } from './pdf-extractor.js';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn(),
}));

const pdfBytes = new Uint8Array(Buffer.from('%PDF-'));

function configurePdf({
  pageCleanup = vi.fn(),
  getTextContent = vi.fn(async () => ({ items: [{ str: 'page text', hasEOL: false }] })),
  documentCleanup = vi.fn(),
  destroy = vi.fn(async () => {}),
}: {
  pageCleanup?: ReturnType<typeof vi.fn>;
  getTextContent?: ReturnType<typeof vi.fn>;
  documentCleanup?: ReturnType<typeof vi.fn>;
  destroy?: ReturnType<typeof vi.fn>;
} = {}) {
  const page = { cleanup: pageCleanup, getTextContent };
  const document = {
    numPages: 1,
    getPage: vi.fn(async () => page),
    cleanup: documentCleanup,
  };
  const loadingTask = { promise: Promise.resolve(document), destroy };
  vi.mocked(pdfjs.getDocument).mockReturnValue(loadingTask as never);
  return { page, document, loadingTask };
}

describe('PdfExtractor cleanup logging', () => {
  const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

  beforeEach(() => {
    logError.mockClear();
    vi.mocked(pdfjs.getDocument).mockReset();
  });

  it('logs parser page cleanup failures with the page number and preserves the parser error', async () => {
    const parserError = new Error('page parsing failed');
    const cleanupError = new Error('page cleanup failed');
    configurePdf({
      pageCleanup: vi.fn(() => { throw cleanupError; }),
      getTextContent: vi.fn(async () => { throw parserError; }),
    });

    await expect(new PdfExtractor().extract(pdfBytes, async () => {})).rejects.toBe(parserError);
    expect(logError).toHaveBeenCalledWith(
      'Failed to clean up PDF page 1 after parsing failure',
      cleanupError.stack,
    );
  });

  it('logs consumer page cleanup failures and preserves the consumer rejection', async () => {
    const cleanupError = 'page cleanup failed';
    configurePdf({ pageCleanup: vi.fn(() => { throw cleanupError; }) });
    const consumerError = new Error('consumer failed');

    await expect(new PdfExtractor().extract(pdfBytes, async () => { throw consumerError; }))
      .rejects.toBe(consumerError);
    expect(logError).toHaveBeenCalledWith(
      'Failed to clean up PDF page 1 after consumer processing',
      cleanupError,
    );
  });

  it('logs document cleanup and loading task destruction failures while extraction succeeds', async () => {
    const documentError = new Error('document cleanup failed');
    const destroyError = new Error('loading task destruction failed');
    const { document, loadingTask } = configurePdf({
      documentCleanup: vi.fn(() => { throw documentError; }),
      destroy: vi.fn(async () => { throw destroyError; }),
    });
    const consumer = vi.fn(async () => {});

    await expect(new PdfExtractor().extract(pdfBytes, consumer)).resolves.toBeUndefined();

    expect(consumer).toHaveBeenCalledOnce();
    expect(document.cleanup).toHaveBeenCalledOnce();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      'Failed to clean up PDF document',
      documentError.stack,
    );
    expect(logError).toHaveBeenCalledWith(
      'Failed to destroy PDF loading task',
      destroyError.stack,
    );
  });
});
