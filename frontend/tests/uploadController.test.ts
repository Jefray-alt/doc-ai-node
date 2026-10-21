// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useChatWorkspace } from '../src/components/ChatWorkspace/useChatWorkspace'
import {
  requestUploadAuthorization,
  uploadFileToStorage,
  UploadTransportError,
} from '../src/components/PdfUpload/uploadTransport'

import type { UploadAuthorization } from '../src/components/PdfUpload/PdfUpload.types'

vi.mock('../src/components/PdfUpload/uploadTransport', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/components/PdfUpload/uploadTransport')>(),
  requestUploadAuthorization: vi.fn(),
  uploadFileToStorage: vi.fn(),
}))

const file = new File(['%PDF-1.7\nexample'], 'notes.pdf', {
  type: 'application/pdf',
})

const secondFile = new File(['second PDF'], 'second.pdf', {
  type: 'application/pdf',
})

const authorization: UploadAuthorization = {
  uploadId: 'first-attempt',
  method: 'PUT',
  url: 'https://storage.example.test/opaque.pdf?signature=secret',
  headers: {
    'Content-Type': 'application/pdf',
  },
  expiresAt: '2026-10-21T00:05:00.000Z',
}

const authorizations: ReturnType<typeof Promise.withResolvers<UploadAuthorization>>[] = []
const transfers: ReturnType<typeof Promise.withResolvers<void>>[] = []

beforeEach(() => {
  vi.resetAllMocks()

  authorizations.length = 0
  transfers.length = 0

  vi.mocked(requestUploadAuthorization).mockImplementation(() => {
    const pending = Promise.withResolvers<UploadAuthorization>()

    authorizations.push(pending)

    return pending.promise
  })

  vi.mocked(uploadFileToStorage).mockImplementation(() => {
    const pending = Promise.withResolvers<void>()

    transfers.push(pending)

    return pending.promise
  })
})

afterEach(cleanup)

function workspace() {
  const hook = renderHook(() => useChatWorkspace())

  function select(candidate = file) {
    let accepted = false

    act(() => {
      accepted = hook.result.current.upload.selectFile(candidate)
    })

    return accepted
  }

  function start() {
    let pending: Promise<void>

    act(() => {
      pending = hook.result.current.upload.startUpload()
    })

    return pending!
  }

  return {
    ...hook,
    select,
    start,
  }
}

async function authorize(index = 0, response = authorization) {
  await act(async () => {
    authorizations[index].resolve(response)
  })
}

async function complete(index = 0) {
  await act(async () => {
    transfers[index].resolve()
  })
}

it('owns an idle upload controller for the lifetime of the workspace', () => {
  const { result } = renderHook(() => useChatWorkspace())

  expect(result.current).toMatchObject({
    upload: {
      state: {
        status: 'idle',
        file: null,
      },
    },
  })
})

describe('candidate checks', () => {
  it.each([
    ['', 1, 'application/pdf', '.pdf filename'],
    ['notes.txt', 1, 'application/pdf', '.pdf filename'],
    ['notes.pdf.exe', 1, 'application/pdf', '.pdf filename'],
    ['notes.pdf', 0, 'application/pdf', 'nonempty PDF'],
    ['notes.pdf', -1, 'application/pdf', 'nonempty PDF'],
    ['notes.pdf', 0.5, 'application/pdf', 'nonempty PDF'],
    ['notes.pdf', Number.NaN, 'application/pdf', 'nonempty PDF'],
    ['notes.pdf', Number.POSITIVE_INFINITY, 'application/pdf', 'nonempty PDF'],
    ['notes.pdf', 10 * 1024 * 1024 + 1, 'application/pdf', '10 MiB'],
    ['notes.pdf', 1, 'text/plain', 'media type'],
  ])('rejects filename=%j size=%j type=%j before authorization', (name, size, type, message) => {
    const candidate = new File(['x'], name as string, {
      type: type as string,
    })

    Object.defineProperty(candidate, 'size', {
      value: size,
    })

    const { result, select, start } = workspace()

    expect(select(candidate)).toBe(false)
    start()

    expect(result.current.upload.state).toMatchObject({
      status: 'idle',
      file: null,
      error: expect.stringContaining(message as string),
    })

    expect(requestUploadAuthorization).not.toHaveBeenCalled()
  })

  it.each(['application/pdf', ''])('accepts the inclusive 10 MiB limit, uppercase extension and media type %j', (type) => {
    const candidate = new File(['x'], 'NOTES.PDF', {
      type,
    })

    Object.defineProperty(candidate, 'size', {
      value: 10 * 1024 * 1024,
    })

    const { result, select, start } = workspace()

    expect(select(candidate)).toBe(true)
    expect(result.current.upload.state).toMatchObject({
      status: 'selected',
      file: candidate,
      error: null,
    })

    start()

    expect(requestUploadAuthorization).toHaveBeenCalledWith({
      filename: 'NOTES.PDF',
      size: 10 * 1024 * 1024,
      contentType: 'application/pdf',
    }, {
      signal: expect.any(AbortSignal),
    })
  })

  it('allows correcting an invalid selection and replacing a selected candidate', () => {
    const { result, select } = workspace()

    select(new File(['bad'], 'bad.txt'))
    expect(select(file)).toBe(true)
    expect(select(secondFile)).toBe(true)

    expect(result.current.upload.state).toMatchObject({
      status: 'selected',
      file: secondFile,
      error: null,
    })
  })
})

it('suppresses duplicate submissions and selections synchronously in both active phases', async () => {
  const { result, select, start } = workspace()

  await start()
  expect(requestUploadAuthorization).not.toHaveBeenCalled()

  select()

  act(() => {
    void result.current.upload.startUpload()
    void result.current.upload.startUpload()
    expect(result.current.upload.selectFile(secondFile)).toBe(false)
  })

  expect(result.current.upload.state.status).toBe('requesting')
  expect(requestUploadAuthorization).toHaveBeenCalledOnce()

  await authorize()
  start()

  expect(select(secondFile)).toBe(false)
  expect(result.current.upload.state.status).toBe('uploading')
  expect(result.current.upload.state.progress).toBeNull()
  expect(uploadFileToStorage).toHaveBeenCalledOnce()
  expect(uploadFileToStorage).toHaveBeenCalledWith(file, authorization, {
    signal: vi.mocked(requestUploadAuthorization).mock.calls[0][1].signal,
    onProgress: expect.any(Function),
  })

  await complete()
})

it('keeps 100 percent progress uploading until storage succeeds, then reserves the workspace slot', async () => {
  const { result, select, start } = workspace()

  select()
  start()
  await authorize()

  act(() => {
    vi.mocked(uploadFileToStorage).mock.calls[0][2].onProgress?.({
      loaded: file.size,
      total: file.size,
    })
  })

  expect(result.current.upload.state).toMatchObject({
    status: 'uploading',
    progress: 100,
  })

  await complete()

  expect(result.current.upload.state).toMatchObject({
    status: 'uploaded',
    file,
    progress: 100,
    error: null,
  })

  expect(select(secondFile)).toBe(false)
  await start()

  act(() => result.current.upload.cancelUpload())

  expect(result.current.upload.state.status).toBe('uploaded')
  expect(requestUploadAuthorization).toHaveBeenCalledOnce()
  expect(uploadFileToStorage).toHaveBeenCalledOnce()
})

it('uses file size for indeterminate progress and bounds reported percentages', async () => {
  const { result, select, start } = workspace()

  select()
  start()
  await authorize()

  const progress = vi.mocked(uploadFileToStorage).mock.calls[0][2].onProgress!

  act(() => progress({ loaded: 5 }))
  expect(result.current.upload.state.progress).toBe(Math.floor(5 / file.size * 100))

  act(() => progress({ loaded: file.size * 2, total: 0 }))
  expect(result.current.upload.state.progress).toBe(100)

  act(() => progress({ loaded: Number.NaN }))
  act(() => progress({ loaded: -5 }))
  expect(result.current.upload.state.progress).toBe(100)
})

it.each(['resolve', 'reject'])('aborts authorization and ignores its late %s after cancellation', async (settlement) => {
  const { result, select, start } = workspace()

  select()
  const pending = start()
  const signal = vi.mocked(requestUploadAuthorization).mock.calls[0][1].signal

  act(() => result.current.upload.cancelUpload())

  expect(signal.aborted).toBe(true)
  expect(result.current.upload.state.status).toBe('cancelled')

  await act(async () => {
    if (settlement === 'resolve') {
      authorizations[0].resolve(authorization)
    } else {
      authorizations[0].reject(new Error(authorization.url))
    }

    await pending
  })

  expect(result.current.upload.state.status).toBe('cancelled')
  expect(uploadFileToStorage).not.toHaveBeenCalled()
})

it('requests fresh authorization on cancelled retry and ignores an older authorization', async () => {
  const { result, select, start } = workspace()

  select()
  const old = start()

  act(() => result.current.upload.cancelUpload())
  start()

  const calls = vi.mocked(requestUploadAuthorization).mock.calls

  expect(calls).toHaveLength(2)
  expect(calls[1][1].signal).not.toBe(calls[0][1].signal)
  expect(calls[1][1].signal.aborted).toBe(false)

  await act(async () => {
    authorizations[0].resolve(authorization)
    await old
  })

  expect(result.current.upload.state.status).toBe('requesting')
  expect(uploadFileToStorage).not.toHaveBeenCalled()

  const fresh = {
    ...authorization,
    uploadId: 'fresh-attempt',
    url: 'https://storage.example.test/new-key.pdf?signature=fresh',
  }

  await authorize(1, fresh)

  expect(uploadFileToStorage).toHaveBeenCalledWith(file, fresh, expect.any(Object))
})

it.each(['resolve', 'reject'])('aborts storage and isolates late progress and %s from a new attempt', async (settlement) => {
  const { result, select, start } = workspace()

  select()
  const old = start()
  await authorize()

  const options = vi.mocked(uploadFileToStorage).mock.calls[0][2]

  act(() => result.current.upload.cancelUpload())

  expect(options.signal.aborted).toBe(true)
  expect(result.current.upload.state.status).toBe('cancelled')

  act(() => options.onProgress?.({ loaded: file.size, total: file.size }))
  expect(result.current.upload.state.progress).toBeNull()

  select(secondFile)
  start()
  await authorize(1)

  await act(async () => {
    options.onProgress?.({ loaded: file.size, total: file.size })

    if (settlement === 'resolve') {
      transfers[0].resolve()
    } else {
      transfers[0].reject(new Error(authorization.url))
    }

    await old
  })

  expect(result.current.upload.state).toMatchObject({
    status: 'uploading',
    file: secondFile,
    progress: null,
  })

  await complete(1)

  act(() => options.onProgress?.({ loaded: 0, total: file.size }))
  expect(result.current.upload.state.status).toBe('uploaded')
  expect(result.current.upload.state.progress).toBe(100)
})

it.each(['authorization', 'storage'])('reports safe %s failure and retries with fresh authorization', async (phase) => {
  const { result, select, start } = workspace()

  select()
  const pending = start()

  if (phase === 'storage') {
    await authorize()
  }

  await act(async () => {
    const request = phase === 'authorization' ? authorizations[0] : transfers[0]

    request.reject(new Error(authorization.url))
    await pending
  })

  expect(result.current.upload.state).toMatchObject({
    status: 'failed',
    file,
    error: phase === 'authorization'
      ? 'Could not authorize the upload. Check the PDF and try again.'
      : 'Could not upload the PDF to storage. Check your connection and try again.',
  })

  expect(JSON.stringify(result.current.upload.state)).not.toContain('signature')

  start()

  expect(result.current.upload.state).toMatchObject({
    status: 'requesting',
    progress: null,
    error: null,
  })

  expect(requestUploadAuthorization).toHaveBeenCalledTimes(2)

  await authorize(1, {
    ...authorization,
    uploadId: 'retry',
  })

  expect(vi.mocked(uploadFileToStorage).mock.lastCall?.[1].uploadId).toBe('retry')
})

it('reports a timeout as retryable without retaining transport diagnostics', async () => {
  const { result, select, start } = workspace()

  select()
  const pending = start()

  await act(async () => {
    authorizations[0].reject(new UploadTransportError('timeout', authorization.url))
    await pending
  })

  expect(result.current.upload.state.error).toBe('Upload request timed out. Try again.')
  expect(result.current.upload.state.status).toBe('failed')
})

it.each(['authorization', 'storage'])('aborts %s on unmount and ignores late events', async (phase) => {
  const { result, select, start, unmount } = workspace()

  select()
  const pending = start()

  if (phase === 'storage') {
    await authorize()
  }

  const beforeUnmount = result.current.upload.state
  const signal = vi.mocked(requestUploadAuthorization).mock.calls[0][1].signal

  unmount()

  expect(signal.aborted).toBe(true)
  expect(result.current.upload.selectFile(secondFile)).toBe(false)
  await result.current.upload.startUpload()

  await act(async () => {
    if (phase === 'authorization') {
      authorizations[0].resolve(authorization)
    } else {
      vi.mocked(uploadFileToStorage).mock.calls[0][2].onProgress?.({ loaded: file.size })
      transfers[0].resolve()
    }

    await pending
  })

  expect(result.current.upload.state).toBe(beforeUnmount)
  expect(requestUploadAuthorization).toHaveBeenCalledOnce()

  if (phase === 'authorization') {
    expect(uploadFileToStorage).not.toHaveBeenCalled()
  }
})

it('preserves completion across dialog close/reopen and chat messages, and resets on remount', async () => {
  const { result, select, start, unmount } = workspace()

  act(() => result.current.openPdfInfo())
  select()
  start()
  await authorize()
  await complete()

  act(() => {
    result.current.closePdfInfo()
    result.current.sendMessage('A question for later')
  })

  expect(result.current.pdfInfoOpened).toBe(false)
  expect(result.current.messages).toEqual([{ id: 1, text: 'A question for later' }])
  expect(result.current.upload.state.status).toBe('uploaded')

  act(() => result.current.openPdfInfo())

  expect(result.current.upload.state.file).toBe(file)
  expect(result.current.upload.state.status).toBe('uploaded')

  unmount()

  const fresh = workspace()

  expect(fresh.result.current.upload.state).toMatchObject({
    status: 'idle',
    file: null,
  })

  expect(fresh.select(secondFile)).toBe(true)
})

it('cancels active work when the workspace closes its dialog', () => {
  const { result, select, start } = workspace()

  act(() => result.current.openPdfInfo())
  select()
  start()

  act(() => result.current.closePdfInfo())

  expect(result.current.pdfInfoOpened).toBe(false)
  expect(result.current.upload.state.status).toBe('cancelled')
  expect(vi.mocked(requestUploadAuthorization).mock.calls[0][1].signal.aborted).toBe(true)
})

it('documents the controller states, workspace retention and cancellation limits', () => {
  const documentation = readFileSync('README.md', 'utf8')

  expect(documentation).toContain('idle → selected → requesting → uploading → uploaded')
  expect(documentation).toContain('failed or cancelled attempt requests fresh authorization')
  expect(documentation).toContain('Closing the dialog preserves a completed upload')
  expect(documentation).toContain('Refresh or remount clears this in-memory state')
  expect(documentation).toContain('Cancellation does not guarantee deletion')
})
