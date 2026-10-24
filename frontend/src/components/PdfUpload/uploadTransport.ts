import axios from 'axios'
import { apiHttp, storageHttp } from '../../api/http'

import type {
  StorageUploadOptions,
  UploadAuthorization,
  UploadErrorCode,
  UploadMetadata,
  UploadRequestOptions,
} from './PdfUpload.types'

export class UploadTransportError extends Error {
  readonly code: UploadErrorCode

  constructor(code: UploadErrorCode, message: string) {
    super(message)

    this.name = 'UploadTransportError'
    this.code = code
  }
}

function normalizeError(
  error: unknown,
  phase: 'authorization' | 'storage',
  signal: AbortSignal,
): UploadTransportError {
  if (signal.aborted || axios.isCancel(error)) {
    return new UploadTransportError('cancelled', 'Upload cancelled.')
  }

  if (
    axios.isAxiosError(error)
    && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')
  ) {
    return new UploadTransportError('timeout', 'Upload request timed out. Try again.')
  }

  const message = phase === 'authorization'
    ? 'Could not authorize the upload. Check the PDF and try again.'
    : 'Could not upload the PDF to storage. Check your connection and try again.'

  // Never retain the Axios cause/config/response, which can contain a signed URL.
  return new UploadTransportError(phase, message)
}

export async function requestUploadAuthorization(
  metadata: UploadMetadata,
  { signal }: UploadRequestOptions,
): Promise<UploadAuthorization> {
  try {
    const response = await apiHttp.post<UploadAuthorization>(
      '/uploads/presign',
      {
        filename: metadata.filename,
        size: metadata.size,
        contentType: metadata.contentType || 'application/pdf',
      },
      {
        signal,
      },
    )

    return response.data
  } catch (error) {
    throw normalizeError(error, 'authorization', signal)
  }
}

export async function uploadFileToStorage(
  file: File,
  authorization: UploadAuthorization,
  { signal, onProgress }: StorageUploadOptions,
): Promise<void> {
  try {
    await storageHttp.request({
      method: authorization.method,
      url: authorization.url,
      data: file,
      headers: {
        ...authorization.headers,
      },
      signal,

      onUploadProgress: onProgress
        ? (event) => onProgress({
          loaded: event.loaded,
          total: event.total ?? file.size,
        })
        : undefined,
    })
  } catch (error) {
    throw normalizeError(error, 'storage', signal)
  }
}
