export const MAX_PDF_BYTES = 10 * 1024 * 1024

export function validatePdfCandidate(file: File): string | null {
  if (typeof file.name !== 'string' || !file.name.trim() || !/\.pdf$/i.test(file.name)) {
    return 'Choose a file with a .pdf filename.'
  }

  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_PDF_BYTES) {
    return 'Choose a nonempty PDF no larger than 10 MiB.'
  }

  if (file.type !== 'application/pdf' && file.type !== '') {
    return 'Choose a PDF with media type application/pdf or an empty media type.'
  }

  return null
}
