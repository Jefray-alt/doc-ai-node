export interface UploadMetadata {
  filename: string
  size: number
  contentType: string
}

export interface UploadAuthorization {
  uploadId: string
  method: 'PUT'
  url: string
  headers: Record<string, string>
  expiresAt: string
}

export interface UploadProgress {
  loaded: number
  total?: number
}

export interface UploadRequestOptions {
  signal: AbortSignal
}

export interface StorageUploadOptions extends UploadRequestOptions {
  onProgress?: (progress: UploadProgress) => void
}

export type UploadErrorCode = 'cancelled' | 'timeout' | 'authorization' | 'storage'

export type PdfUploadStatus =
  | 'idle'
  | 'selected'
  | 'requesting'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'cancelled'

export interface PdfUploadState {
  status: PdfUploadStatus
  file: File | null
  progress: number | null
  error: string | null
}

export interface PdfUploadAttempt {
  controller: AbortController
}

export interface PdfUploadController {
  state: PdfUploadState
  selectFile: (file: File) => boolean
  startUpload: () => Promise<void>
  cancelUpload: () => void
}

export interface PdfUploadProps {
  opened: boolean
  onClose: () => void
  upload: PdfUploadController
}
