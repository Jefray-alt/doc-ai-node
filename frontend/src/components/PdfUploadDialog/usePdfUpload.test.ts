import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { usePdfUpload } from './usePdfUpload'

describe('usePdfUpload file selection', () => {
  it('clears selection and validation errors when the picker is cancelled', () => {
    const { result } = renderHook(() => usePdfUpload())
    const validFile = new File(['%PDF'], 'document.pdf', { type: 'application/pdf' })
    const invalidFile = new File(['text'], 'notes.txt', { type: 'text/plain' })

    act(() => result.current.selectFile(validFile))
    expect(result.current.file).toBe(validFile)

    act(() => result.current.selectFile(invalidFile))
    expect(result.current.file).toBeNull()
    expect(result.current.errorMessage).toBe('Choose a PDF file.')

    act(() => result.current.selectFile(null))
    expect(result.current.file).toBeNull()
    expect(result.current.errorMessage).toBe('')
    expect(result.current.status).toBe('idle')
  })
})
