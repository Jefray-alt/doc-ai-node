export class DownloadTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly actualBytes: number,
  ) {
    super(`PDF object exceeds the ${maxBytes}-byte download limit`);
    this.name = 'DownloadTooLargeError';
  }
}
