import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useUploadStatus } from './useUploadStatus'
import type { UploadJobStatus } from '../PdfUploadDialog/UploadJob.types'

const queued: UploadJobStatus = {
  uploadId: 'upload-123', status: 'queued', updatedAt: '2026-01-01T00:00:00.000Z', error: null,
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useUploadStatus', () => {
  it('polls sequentially every two seconds and stops after a terminal response', async () => {
    vi.useFakeTimers()
    let resolvePoll!: (response: { ok: boolean; json: () => Promise<UploadJobStatus> }) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...queued, status: 'source_checked' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useUploadStatus(queued))

    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolvePoll({ ok: true, json: async () => ({ ...queued, status: 'processing' }) })
      await Promise.resolve()
    })
    expect(result.current.status?.status).toBe('processing')
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.status?.status).toBe('source_checked')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the authoritative status after connectivity errors and retries later', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...queued, status: 'processing' }) })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useUploadStatus(queued))

    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.status).toEqual(queued)
    expect(result.current.connectionError).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(result.current.status?.status).toBe('processing')
    expect(result.current.connectionError).toBe(false)
  })

  it('does not poll an initially terminal upload', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const terminal = { ...queued, status: 'failed' as const, error: 'safe failure' }
    const { result } = renderHook(() => useUploadStatus(terminal))

    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(result.current.status).toEqual(terminal)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts and ignores an old upload response after the upload ID changes', async () => {
    vi.useFakeTimers()
    let resolveOld!: (response: { ok: boolean; json: () => Promise<UploadJobStatus> }) => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const nextUpload = { ...queued, uploadId: 'upload-456', status: 'processing' as const }
    const { result, rerender } = renderHook(({ current }) => useUploadStatus(current), { initialProps: { current: queued } })

    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal
    rerender({ current: nextUpload })
    expect(oldSignal.aborted).toBe(true)
    expect(result.current.status).toEqual(nextUpload)
    await act(async () => {
      resolveOld({ ok: true, json: async () => ({ ...queued, status: 'failed', error: 'stale' }) })
      await Promise.resolve()
    })
    expect(result.current.status).toEqual(nextUpload)
  })

  it('aborts an in-flight status request on unmount and never schedules another poll', async () => {
    vi.useFakeTimers()
    let resolveJson!: (status: UploadJobStatus) => void
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise((resolve) => { resolveJson = resolve }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = renderHook(() => useUploadStatus(queued))

    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => {
      resolveJson({ ...queued, status: 'failed', error: 'late' })
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
