import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useChatWorkspace } from './useChatWorkspace'

describe('useChatWorkspace', () => {
  it('starts with no messages and the PDF dialog closed', () => {
    const { result } = renderHook(() => useChatWorkspace())

    expect(result.current.messages).toEqual([])
    expect(result.current.pdfInfoOpened).toBe(false)
  })

  it('appends messages in order with unique IDs, including batched sends', () => {
    const { result } = renderHook(() => useChatWorkspace())

    act(() => {
      result.current.sendMessage('First message')
      result.current.sendMessage('Second message')
    })
    act(() => result.current.sendMessage('Third message'))

    expect(result.current.messages.map(({ text }) => text)).toEqual([
      'First message', 'Second message', 'Third message',
    ])
    expect(new Set(result.current.messages.map(({ id }) => id)).size).toBe(3)
  })

  it('opens and closes PDF information without clearing messages', () => {
    const { result } = renderHook(() => useChatWorkspace())
    act(() => result.current.sendMessage('Keep this message'))

    act(() => result.current.openPdfInfo())
    expect(result.current.pdfInfoOpened).toBe(true)

    act(() => result.current.closePdfInfo())
    expect(result.current.pdfInfoOpened).toBe(false)
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0]?.text).toBe('Keep this message')
  })
})
