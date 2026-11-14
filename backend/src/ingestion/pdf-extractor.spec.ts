import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { S3Client } from '@aws-sdk/client-s3';
import {
  PdfExtractionError,
  PdfInputVerificationError,
  PdfPageLimitError,
  PdfExtractor,
} from './pdf-extractor.ts';
import { PdfDownloader } from './pdf-downloader.ts';
import { IngestionService } from './ingestion.service.ts';

const EMPTY_PASSWORD_ENCRYPTED_PDF = 'JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NSA+PgpzdHJlYW0KGteTT6dCxGhKqKHQrWENdAEL4lXKBslbmuUwa04HvreyZetISrKFX0Ya9/sACmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL0ZpbHRlciAvU3RhbmRhcmQgL1YgMSAvUiAyIC9MZW5ndGggNDAgL08gPGM5MjQyMjY4N2ZhY2VlNjg2ZTM3M2YxMGI1YzdkMDQ3MzgwNTMxNTJmN2UyZWUzMGUxMWM2OWVjNDQyNTc2YWI+IC9VIDxiYTM4ZjQ4YmE5MWQ5OGYwODBiMDMwNjYwZmExZTE5N2Y2MmI1YWVmZjdkZjY4NDVkZWRhNjgyNDEzMWUwOTdlPiAvUCAtNCA+PgplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzYgMDAwMDAgbiAKMDAwMDAwMDQwNiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIgL0lEIFs8MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDc+IDwwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNz5dID4+CnN0YXJ0eHJlZgo2MTIKJSVFT0Y=';
const PASSWORD_REQUIRED_PDF = 'JVBERi0xLjcKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NSA+PgpzdHJlYW0Kq7RpLUnNkWZggAe3uXzNcsD/Li3DQkFCdsjo9ac3BVp9o/T26L1KEfOi9NiCCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL0ZpbHRlciAvU3RhbmRhcmQgL1YgMSAvUiAyIC9MZW5ndGggNDAgL08gPDkyZmUwZjQ0NTRhZDRjOTY0NDY5M2YzM2MwN2NiNTRmNTg3ZGNlMWUyNjgyZmU5ZWNlYTYxMDdhMWVmNjMwZGQ+IC9VIDw4OGRlZmZjZTA5ZjZhMTcyMjExMWM3MTI4YTA0MjNmNGM0OWRhZGE5M2YzYzZhNDI1NGIzZDc1OGI0ZDNmOWZjPiAvUCAtNCA+PgplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzYgMDAwMDAgbiAKMDAwMDAwMDQwNiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIgL0lEIFs8MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDc+IDwwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNzA3MDcwNz5dID4+CnN0YXJ0eHJlZgo2MTIKJSVFT0Y=';

function makePdf(pageContents: string[]): Uint8Array {
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(`<< /Type /Pages /Kids [${pageContents.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pageContents.length} >>`),
  ];

  pageContents.forEach((content, index) => {
    const pageObject = 3 + index * 2;
    const contentObject = pageObject + 1;
    objects.push(Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pageContents.length * 2} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    ));
    const streamBytes = Buffer.from(content);
    objects.push(Buffer.concat([
      Buffer.from(`<< /Length ${streamBytes.byteLength} >>\nstream\n`),
      streamBytes,
      Buffer.from('\nendstream'),
    ]));
  });

  objects.push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.concat(parts).byteLength);
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n'));
  });

  const xrefOffset = Buffer.concat(parts).byteLength;
  const xrefEntries = offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('');
  parts.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefEntries}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`,
  ));

  return new Uint8Array(Buffer.concat(parts));
}

const text = (value: string) => `BT /F1 12 Tf 72 720 Td (${value}) Tj ET`;

describe('PdfExtractor', () => {
  it('delivers page text sequentially, including blank pages, and waits for each consumer', async () => {
    const extractor = new PdfExtractor();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstPageGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const extraction = extractor.extract(makePdf([text('first page'), '', text('third page')]), async (page) => {
      events.push(`start:${page.pageNumber}:${page.text.replace(/\s+/g, ' ').trim()}`);
      if (page.pageNumber === 1) {
        await firstPageGate;
      }
      events.push(`done:${page.pageNumber}`);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['start:1:first page']);
    releaseFirst?.();
    await extraction;

    expect(events).toEqual([
      'start:1:first page', 'done:1',
      'start:2:', 'done:2',
      'start:3:third page', 'done:3',
    ]);
  });

  it('preserves PDF.js line breaks in extracted page text', async () => {
    const pages: string[] = [];
    await new PdfExtractor().extract(
      makePdf(['BT /F1 12 Tf 72 720 Td (first line) Tj 0 -20 Td (second line) Tj ET']),
      async ({ text: pageText }) => { pages.push(pageText); },
    );

    expect(pages[0]).toContain('first line\nsecond line');
  });

  it('rejects input without a PDF header as a verification error', async () => {
    await expect(new PdfExtractor().extract(new Uint8Array(Buffer.from('not a pdf')), async () => {}))
      .rejects.toBeInstanceOf(PdfInputVerificationError);

    const maskedAsciiHeader = new Uint8Array([0xa5, 0x50, 0x44, 0x46, 0x2d]);
    await expect(new PdfExtractor().extract(maskedAsciiHeader, async () => {}))
      .rejects.toBeInstanceOf(PdfInputVerificationError);
  });

  it('rejects oversized input before parsing', async () => {
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    bytes.set(Buffer.from('%PDF-'));
    await expect(new PdfExtractor().extract(bytes, async () => {}))
      .rejects.toMatchObject({ code: 'PDF_TOO_LARGE' });
  });

  it('rejects documents above the physical page limit before delivering pages', async () => {
    const oversized = makePdf(Array.from({ length: 101 }, () => ''));
    const consumer = vi.fn(async () => {});
    await expect(new PdfExtractor().extract(oversized, consumer)).rejects.toBeInstanceOf(PdfPageLimitError);
    expect(consumer).not.toHaveBeenCalled();
  });

  it('reports malformed PDFs with a deterministic extraction error', async () => {
    await expect(new PdfExtractor().extract(new Uint8Array(Buffer.from('%PDF-1.7\nthis is broken')), async () => {}))
      .rejects.toBeInstanceOf(PdfExtractionError);
  });

  it('accepts an encrypted PDF whose user password is empty', async () => {
    const pages: string[] = [];
    await new PdfExtractor().extract(new Uint8Array(Buffer.from(EMPTY_PASSWORD_ENCRYPTED_PDF, 'base64')), async ({ text: pageText }) => {
      pages.push(pageText);
    });

    expect(pages[0]).toContain('encrypted text');
  });

  it('reports password-required PDFs with a distinct deterministic extraction error', async () => {
    const consumer = vi.fn(async () => {});
    await expect(new PdfExtractor().extract(new Uint8Array(Buffer.from(PASSWORD_REQUIRED_PDF, 'base64')), consumer))
      .rejects.toMatchObject({ code: 'PDF_PASSWORD_REQUIRED' });
    expect(consumer).not.toHaveBeenCalled();
  });

  it('rejects PDFs that contain no extractable text', async () => {
    await expect(new PdfExtractor().extract(makePdf(['', '']), async () => {}))
      .rejects.toMatchObject({ code: 'PDF_NO_TEXT' });
  });

  it('preserves consumer rejection identity', async () => {
    const callbackError = new Error('consumer failed');
    await expect(new PdfExtractor().extract(makePdf([text('hello')]), async () => { throw callbackError; }))
      .rejects.toBe(callbackError);
  });
});

describe('IngestionService', () => {
  it('downloads one stored object and passes its parsed pages to the consumer', async () => {
    const bytes = makePdf([text('stored document')]);
    const send = vi.fn(async (command: { input: { Bucket?: string; Key?: string } }) => {
      expect(command.input).toMatchObject({ Bucket: 'documents', Key: 'object.pdf' });
      return { Body: Readable.from([bytes]), ContentLength: bytes.byteLength };
    });
    const downloader = new PdfDownloader({ send } as unknown as S3Client);
    const seen: Array<{ pageNumber: number; text: string }> = [];

    await new IngestionService(downloader, new PdfExtractor()).extract('documents', 'object.pdf', async (page) => {
      seen.push(page);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ pageNumber: 1, text: expect.stringContaining('stored document') });
    expect(send).toHaveBeenCalledOnce();
  });

  it('preserves consumer rejection through the combined download and extraction API', async () => {
    const callbackError = new Error('consumer failed');
    const downloader = { download: async () => makePdf([text('stored document')]) } as unknown as PdfDownloader;

    await expect(new IngestionService(downloader, new PdfExtractor()).extract('documents', 'object.pdf', async () => {
      throw callbackError;
    })).rejects.toBe(callbackError);
  });
});
