// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { MAX_PDF_BYTES, pdfCandidateSchema, validatePdfCandidate } from './validation'

function pdfFile(name = 'document.pdf', size = 1, type = 'application/pdf') {
  return new File([new Uint8Array(size)], name, { type })
}

describe('pdfCandidateSchema', () => {
  it('accepts a nonempty PDF up to the configured limit', () => {
    expect(validatePdfCandidate(pdfFile())).toBeNull()
    expect(validatePdfCandidate(pdfFile('DOCUMENT.PDF', MAX_PDF_BYTES, ''))).toBeNull()
  })

  it.each([
    [pdfFile(''), 'Choose a file with a .pdf filename.'],
    [pdfFile('   '), 'Choose a file with a .pdf filename.'],
    [pdfFile('document.txt'), 'Choose a file with a .pdf filename.'],
    [pdfFile('document.pdf', 0), 'Choose a nonempty PDF no larger than 10 MiB.'],
    [pdfFile('document.pdf', MAX_PDF_BYTES + 1), 'Choose a nonempty PDF no larger than 10 MiB.'],
    [pdfFile('document.pdf', 1, 'text/plain'), 'Choose a PDF with media type application/pdf or an empty media type.'],
  ])('rejects invalid candidates with a useful message', (file, message) => {
    expect(pdfCandidateSchema.safeParse({ name: file.name, size: file.size, type: file.type }).success)
      .toBe(false)
    expect(validatePdfCandidate(file)).toBe(message)
  })
})
