export type PdfPageText = {
  pageNumber: number;
  text: string;
};

export type PdfPageConsumer = (page: PdfPageText) => void | Promise<void>;

export class PdfInputVerificationError extends Error {
  constructor(readonly code: 'PDF_TOO_LARGE' | 'PDF_INVALID_HEADER') {
    super(code === 'PDF_TOO_LARGE' ? 'PDF exceeds the 20 MiB extraction limit' : 'Input does not have a PDF header');
    this.name = 'PdfInputVerificationError';
  }
}

export class PdfExtractionError extends Error {
  constructor(readonly code: 'PDF_MALFORMED' | 'PDF_PASSWORD_REQUIRED' | 'PDF_NO_TEXT') {
    const message = {
      PDF_MALFORMED: 'PDF is malformed or cannot be parsed',
      PDF_PASSWORD_REQUIRED: 'PDF requires a password',
      PDF_NO_TEXT: 'PDF contains no extractable text',
    }[code];
    super(message);
    this.name = 'PdfExtractionError';
  }
}

export class PdfPageLimitError extends Error {
  constructor(readonly maxPages: number) {
    super(`PDF exceeds the ${maxPages}-page extraction limit`);
    this.name = 'PdfPageLimitError';
  }
}
