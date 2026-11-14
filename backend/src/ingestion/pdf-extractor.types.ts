export type PdfPageText = {
  pageNumber: number;
  text: string;
};

export type PdfPageConsumer = (page: PdfPageText) => void | Promise<void>;
