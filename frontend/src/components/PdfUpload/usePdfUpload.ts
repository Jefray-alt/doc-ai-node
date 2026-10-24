import { useEffect, useRef, useState } from 'react'

import {
  requestUploadAuthorization,
  uploadFileToStorage,
  UploadTransportError,
} from './uploadTransport'
import { validatePdfCandidate } from './validation'

import type {
  PdfUploadAttempt,
  PdfUploadController,
  PdfUploadState,
} from './PdfUpload.types'

export function usePdfUpload(): PdfUploadController {
  const [state, setState] = useState<PdfUploadState>({
    status: 'idle',
    file: null,
    progress: null,
    error: null,
  })

  const currentState = useRef(state)
  const activeAttempt = useRef<PdfUploadAttempt | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false

      const attempt = activeAttempt.current

      activeAttempt.current = null
      attempt?.controller.abort()
    }
  }, [])

  function transition(next: PdfUploadState) {
    currentState.current = next
    setState(next)
  }

  function selectFile(file: File): boolean {
    if (!mounted.current || activeAttempt.current || currentState.current.status === 'uploaded') {
      return false
    }

    const error = validatePdfCandidate(file)

    transition({
      status: error ? 'idle' : 'selected',
      file: error ? null : file,
      progress: null,
      error,
    })

    return error === null
  }

  function cancelUpload() {
    const attempt = activeAttempt.current

    if (!mounted.current || !attempt) {
      return
    }

    // Invalidate before aborting: even a synchronous abort callback is stale.
    activeAttempt.current = null
    attempt.controller.abort()

    transition({
      ...currentState.current,
      status: 'cancelled',
      error: null,
    })
  }

  async function startUpload() {
    const candidate = currentState.current

    if (
      !mounted.current
      || activeAttempt.current
      || !candidate.file
      || !['selected', 'failed', 'cancelled'].includes(candidate.status)
    ) {
      return
    }

    const file = candidate.file
    const attempt: PdfUploadAttempt = {
      controller: new AbortController(),
    }

    activeAttempt.current = attempt

    const isCurrent = () => mounted.current && activeAttempt.current === attempt

    transition({
      status: 'requesting',
      file,
      progress: null,
      error: null,
    })

    let phase: 'authorization' | 'storage' = 'authorization'

    try {
      const authorization = await requestUploadAuthorization({
        filename: file.name,
        size: file.size,
        contentType: file.type || 'application/pdf',
      }, {
        signal: attempt.controller.signal,
      })

      if (!isCurrent()) {
        return
      }

      phase = 'storage'

      transition({
        status: 'uploading',
        file,
        progress: null,
        error: null,
      })

      await uploadFileToStorage(file, authorization, {
        signal: attempt.controller.signal,

        onProgress: ({ loaded, total }) => {
          if (!isCurrent() || !Number.isFinite(loaded) || loaded < 0) {
            return
          }

          const bytes = total && Number.isFinite(total) && total > 0 ? total : file.size
          const progress = Math.min(100, Math.floor(loaded / bytes * 100))

          transition({
            ...currentState.current,
            progress,
          })
        },
      })

      if (isCurrent()) {
        transition({
          status: 'uploaded',
          file,
          progress: 100,
          error: null,
        })
      }
    } catch (error) {
      if (!isCurrent()) {
        return
      }

      const timedOut = error instanceof UploadTransportError && error.code === 'timeout'

      const message = phase === 'authorization'
        ? 'Could not authorize the upload. Check the PDF and try again.'
        : 'Could not upload the PDF to storage. Check your connection and try again.'

      transition({
        ...currentState.current,
        status: 'failed',
        error: timedOut ? 'Upload request timed out. Try again.' : message,
      })
    } finally {
      if (isCurrent()) {
        activeAttempt.current = null
      }
    }
  }

  return {
    state,
    selectFile,
    startUpload,
    cancelUpload,
  }
}
