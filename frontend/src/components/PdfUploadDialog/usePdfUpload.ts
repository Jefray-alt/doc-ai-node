import { useCallback, useEffect, useRef, useState } from 'react'
import { pdfFileSchema } from './PdfUploadDialog.schema'
import type { PdfUploadOperationStatus, PresignedPdfUpload, UploadJobStatus, UploadedPdf } from './UploadJob.types'

export function usePdfUpload(onUploadSuccess?: (upload: UploadedPdf) => void) {
  const [file, setFile] = useState<File | null>(null)
  const [uploadId, setUploadId] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<UploadJobStatus | null>(null)
  const [status, setStatus] = useState<PdfUploadOperationStatus>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const generationRef = useRef(0)
  const controllersRef = useRef<AbortController[]>([])
  const callbackRef = useRef(onUploadSuccess)
  const actionLockRef = useRef(false)

  useEffect(() => { callbackRef.current = onUploadSuccess }, [onUploadSuccess])

  const invalidate = useCallback(() => {
    generationRef.current += 1
    for (const controller of controllersRef.current) controller.abort()
    controllersRef.current = []
    return generationRef.current
  }, [])

  useEffect(() => () => { invalidate() }, [invalidate])

  const resetSession = useCallback(() => {
    invalidate()
    actionLockRef.current = false
    setFile(null)
    setUploadId(null)
    setJobStatus(null)
    setStatus('idle')
    setErrorMessage('')
  }, [invalidate])

  function selectFile(selectedFile: File | null) {
    invalidate()
    actionLockRef.current = false
    setUploadId(null)
    setJobStatus(null)
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

  function newController() {
    const controller = new AbortController()
    controllersRef.current.push(controller)
    return controller
  }

  async function confirmUpload(id: string, selectedFile: File, generation: number) {
    setStatus('confirming')
    setErrorMessage('')
    try {
      const controller = newController()
      const response = await fetch(`/api/uploads/${id}/complete`, { method: 'POST', signal: controller.signal })
      if (generation !== generationRef.current) return
      if (!response.ok) throw new Error('confirmation failed')
      const result = await response.json() as UploadJobStatus
      if (generation !== generationRef.current) return
      setJobStatus(result)
      setStatus('complete')
      callbackRef.current?.({ fileName: selectedFile.name, uploadId: id, status: result })
    } catch {
      if (generation !== generationRef.current) return
      setStatus('confirmation_error')
      setErrorMessage('Upload succeeded, but confirmation failed. Retry confirmation to check the document status.')
    } finally {
      if (generation === generationRef.current) actionLockRef.current = false
    }
  }

  async function uploadFile() {
    if (!file || actionLockRef.current || status === 'uploading' || status === 'confirming') return
    if (uploadId && status === 'confirmation_error') {
      actionLockRef.current = true
      const generation = invalidate()
      await confirmUpload(uploadId, file, generation)
      return
    }

    const generation = invalidate()
    actionLockRef.current = true
    const selectedFile = file
    setStatus('uploading')
    setErrorMessage('')
    try {
      const authorizationController = newController()
      const authorizationResponse = await fetch('/api/uploads/presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: selectedFile.name, contentType: selectedFile.type, sizeBytes: selectedFile.size }),
        signal: authorizationController.signal,
      })
      if (generation !== generationRef.current) return
      if (!authorizationResponse.ok) throw new Error('authorization failed')
      const authorization = await authorizationResponse.json() as PresignedPdfUpload
      if (generation !== generationRef.current) return
      const formData = new FormData()
      for (const [name, value] of Object.entries(authorization.fields)) formData.append(name, value)
      formData.append('file', selectedFile, selectedFile.name)

      const storageController = newController()
      const uploadResponse = await fetch(authorization.url, { method: 'POST', body: formData, signal: storageController.signal })
      if (generation !== generationRef.current) return
      if (!uploadResponse.ok) throw new Error('storage upload failed')
      setUploadId(authorization.uploadId)
      await confirmUpload(authorization.uploadId, selectedFile, generation)
    } catch {
      if (generation !== generationRef.current) return
      setStatus('upload_error')
      setErrorMessage('Upload failed. Please try again.')
    } finally {
      if (generation === generationRef.current) actionLockRef.current = false
    }
  }

  return { file, uploadId, jobStatus, status, errorMessage, selectFile, uploadFile, resetSession }
}
