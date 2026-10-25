import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { render } from '../../test/render'
import { ChatMessage } from './ChatMessage'

describe('ChatMessage', () => {
  it('renders the author and message text in its message container', () => {
    render(<ChatMessage message={{ id: 1, text: 'A supported message' }} />)

    expect(screen.getByRole('heading', { name: 'You' })).toBeInTheDocument()
    expect(screen.getByText('A supported message')).toBeInTheDocument()
    expect(screen.getByTestId('chat-message').tagName).toBe('ARTICLE')
  })
})
