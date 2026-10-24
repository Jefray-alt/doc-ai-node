import { z } from 'zod'

export const MAX_PDF_BYTES = 10 * 1024 * 1024

export const pdfCandidateSchema = z.object({
  name: z.string().refine(
    (name) => name.trim().length > 0 && /\.pdf$/i.test(name),
    'Choose a file with a .pdf filename.',
  ),
  size: z.number({ error: 'Choose a nonempty PDF no larger than 10 MiB.' })
    .int('Choose a nonempty PDF no larger than 10 MiB.')
    .min(1, 'Choose a nonempty PDF no larger than 10 MiB.')
    .max(MAX_PDF_BYTES, 'Choose a nonempty PDF no larger than 10 MiB.'),
  type: z.string().refine(
    (type) => type === 'application/pdf' || type === '',
    'Choose a PDF with media type application/pdf or an empty media type.',
  ),
})

export function validatePdfCandidate(file: File): string | null {
  const result = pdfCandidateSchema.safeParse({
    name: file.name,
    size: file.size,
    type: file.type,
  })

  return result.success ? null : result.error.issues[0]?.message ?? 'Choose a valid PDF.'
}
