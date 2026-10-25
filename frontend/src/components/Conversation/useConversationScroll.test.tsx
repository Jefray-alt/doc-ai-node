import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationProps } from './Conversation.types'
import { useConversationScroll } from './useConversationScroll'

function ScrollHarness({ messages }: ConversationProps) {
  const ref = useConversationScroll(messages)
  return <div ref={ref} role="log" aria-label="Scroll target" />
}

describe('useConversationScroll', () => {
  it('scrolls to the bottom on mount', () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(400)

    render(<ScrollHarness messages={[{ id: 1, text: 'Existing message' }]} />)

    expect(screen.getByRole('log', { name: 'Scroll target' }).scrollTop).toBe(400)
  })

  it('scrolls to the new bottom when messages change', () => {
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200)
    const { rerender } = render(<ScrollHarness messages={[]} />)
    const log = screen.getByRole('log', { name: 'Scroll target' })
    log.scrollTop = 20
    height.mockReturnValue(600)

    rerender(<ScrollHarness messages={[{ id: 1, text: 'New message' }]} />)

    expect(log.scrollTop).toBe(600)
  })
})
