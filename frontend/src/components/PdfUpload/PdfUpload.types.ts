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
