import type { UploadedPdf } from './UploadJob.types'

export type PdfUploadDialogProps = {
  opened: boolean
  onClose: () => void
  onUploadSuccess?: (upload: UploadedPdf) => void
}
