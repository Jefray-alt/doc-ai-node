import { useCallback, useRef, useState } from 'react'
import { pdfFileSchema } from './PdfUploadDialog.schema'

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

type PresignedUpload = {
  url: string
  fields: Record<string, string>
}

export function usePdfUpload(onUploadSuccess?: (fileName: string) => void) {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const sessionRef = useRef(0)

  const resetSession = useCallback(() => {
    sessionRef.current += 1
    setFile(null)
    setStatus('idle')
    setErrorMessage('')
  }, [])

  function selectFile(selectedFile: File | null) {
    setErrorMessage('')
    setStatus('idle')

    if (selectedFile === null) {
      setFile(null)
      return
    }

    const validation = pdfFileSchema.safeParse(selectedFile)
    if (!validation.success) {
      setFile(null)
      setErrorMessage(validation.error.issues[0]?.message ?? 'Choose a PDF file.')
      return
    }

    setFile(validation.data)
  }

  async function uploadFile() {
    if (!file || status === 'uploading') return

    const session = sessionRef.current
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
      if (session !== sessionRef.current) return

      const authorization = await authorizationResponse.json() as PresignedUpload
      if (session !== sessionRef.current) return
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
      if (session !== sessionRef.current) return

      setStatus('success')
      onUploadSuccess?.(file.name)
    } catch {
      if (session !== sessionRef.current) return
      setStatus('error')
      setErrorMessage('Upload failed. Please try again.')
    }
  }

  return { file, status, errorMessage, selectFile, uploadFile, resetSession }
}
