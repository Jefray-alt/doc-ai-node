import { useEffect, useState } from 'react'
import type { UploadJobStatus } from '../PdfUploadDialog/UploadJob.types'

const POLL_INTERVAL_MS = 2000

export function useUploadStatus(initialStatus: UploadJobStatus | null) {
  const [polledStatus, setPolledStatus] = useState<UploadJobStatus | null>(null)
  const [failedUploadId, setFailedUploadId] = useState<string | null>(null)
  const uploadId = initialStatus?.uploadId
  const initialIsTerminal = !initialStatus || isTerminal(initialStatus)

  useEffect(() => {
    if (!uploadId || initialIsTerminal) return

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const schedule = () => {
      timer = setTimeout(() => { void poll() }, POLL_INTERVAL_MS)
    }
    const poll = async () => {
      controller = new AbortController()
      try {
        const response = await fetch(`/api/uploads/${uploadId}/status`, {
          cache: 'no-store', signal: controller.signal,
        })
        if (!response.ok) throw new Error('status request failed')
        const nextStatus = await response.json() as UploadJobStatus
        if (!active) return
        setPolledStatus(nextStatus)
        setFailedUploadId(null)
        if (!isTerminal(nextStatus)) schedule()
      } catch {
        if (!active || controller.signal.aborted) return
        setFailedUploadId(uploadId)
        schedule()
      }
    }
    schedule()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
      controller?.abort()
    }
  }, [uploadId, initialStatus?.status, initialStatus?.updatedAt, initialIsTerminal])

  return {
    status: polledStatus && polledStatus.uploadId === uploadId
      && (!initialStatus || polledStatus.updatedAt >= initialStatus.updatedAt)
      ? polledStatus : initialStatus,
    connectionError: failedUploadId === uploadId,
  }
}

function isTerminal(status: UploadJobStatus) {
  return status.status === 'source_checked' || status.status === 'failed'
}
