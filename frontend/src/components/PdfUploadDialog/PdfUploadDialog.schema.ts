import { z } from 'zod'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export const pdfFileSchema = z.instanceof(File).superRefine((file, context) => {
  if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) {
    context.addIssue({ code: 'custom', message: 'Choose a PDF file.' })
    return
  }

  if (file.size < 1) {
    context.addIssue({ code: 'custom', message: 'The PDF file is empty.' })
  } else if (file.size > MAX_UPLOAD_BYTES) {
    context.addIssue({ code: 'custom', message: 'PDF files must be no larger than 20 MiB.' })
  }
})
