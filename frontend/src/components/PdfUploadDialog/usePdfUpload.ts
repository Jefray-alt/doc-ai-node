import { useState } from 'react'

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

type PresignedUpload = {
  url: string
  fields: Record<string, string>
}

export function usePdfUpload(onUploadSuccess?: (fileName: string) => void) {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')

  function selectFile(selectedFile: File | null) {
    setErrorMessage('')
    setStatus('idle')
    if (
      selectedFile &&
      (selectedFile.type !== 'application/pdf' ||
        !selectedFile.name.toLowerCase().endsWith('.pdf') ||
        selectedFile.size < 1 ||
        selectedFile.size > MAX_UPLOAD_BYTES)
    ) {
      setFile(null)
      setErrorMessage('Choose a PDF file no larger than 20 MiB.')
      return
    }
    setFile(selectedFile)
  }

  async function uploadFile() {
    if (!file || status === 'uploading') return

    setStatus('uploading')
    setErrorMessage('')
    try {
      const authorizationResponse = await fetch('/api/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
        }),
      })
      if (!authorizationResponse.ok) throw new Error('authorization failed')

      const authorization = await authorizationResponse.json() as PresignedUpload
      const formData = new FormData()
      for (const [name, value] of Object.entries(authorization.fields)) {
        formData.append(name, value)
      }
      formData.append('file', file, file.name)

      const uploadResponse = await fetch(authorization.url, {
        method: 'POST',
        body: formData,
      })
      if (!uploadResponse.ok) throw new Error('storage upload failed')

      setStatus('success')
      onUploadSuccess?.(file.name)
    } catch {
      setStatus('error')
      setErrorMessage('Upload failed. Please try again.')
    }
  }

  return { file, status, errorMessage, selectFile, uploadFile }
}
