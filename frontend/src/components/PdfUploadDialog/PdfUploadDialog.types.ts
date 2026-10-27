export type PdfUploadDialogProps = {
  opened: boolean
  onClose: () => void
  onUploadSuccess?: (fileName: string) => void
}
