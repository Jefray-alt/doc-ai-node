import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessageProps } from '../ChatMessage/ChatMessage.types'
import { render } from '../../test/render'
import { Conversation } from './Conversation'

vi.mock('../ChatMessage/ChatMessage', () => ({
  ChatMessage: ({ message }: ChatMessageProps) => (
    <div data-testid="mock-chat-message">{message.text}</div>
  ),
}))

describe('Conversation', () => {
  it('shows an empty state inside the accessible conversation log', () => {
    render(<Conversation messages={[]} />)
    const log = screen.getByRole('log', { name: 'Conversation' })

    expect(within(log).getByText('No messages yet')).toBeInTheDocument()
    expect(within(log).queryAllByTestId('mock-chat-message')).toHaveLength(0)
    expect(log).toHaveAttribute('aria-live', 'polite')
  })

  it('replaces the empty state with message containers in conversation order', () => {
    const { rerender } = render(<Conversation messages={[]} />)

    rerender(<Conversation messages={[
      { id: 2, text: 'First message' },
      { id: 1, text: 'Second message' },
    ]} />)

    const log = screen.getByRole('log', { name: 'Conversation' })
    expect(within(log).queryByText('No messages yet')).not.toBeInTheDocument()
    const messages = within(log).getAllByTestId('mock-chat-message')
    expect(messages).toHaveLength(2)
    expect(within(messages[0]!).getByText('First message')).toBeInTheDocument()
    expect(within(messages[1]!).getByText('Second message')).toBeInTheDocument()
  })
})
