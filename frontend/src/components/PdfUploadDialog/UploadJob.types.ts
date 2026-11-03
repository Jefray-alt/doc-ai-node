export type UploadJobState = 'queued' | 'processing' | 'source_checked' | 'failed'

export type UploadJobStatus = {
  uploadId: string
  status: UploadJobState
  updatedAt: string
  error: string | null
}

export type UploadedPdf = {
  fileName: string
  uploadId: string
  status: UploadJobStatus
}

export type PdfUploadOperationStatus = 'idle' | 'uploading' | 'confirming' | 'confirmation_error' | 'complete' | 'upload_error'

export type PresignedPdfUpload = {
  uploadId: string
  url: string
  fields: Record<string, string>
}
