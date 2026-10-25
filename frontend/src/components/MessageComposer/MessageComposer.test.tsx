import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { render } from '../../test/render'
import { MessageComposer } from './MessageComposer'

describe('MessageComposer', () => {
  it('enables sending only when the draft contains non-whitespace text', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<MessageComposer onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: 'Message' })
    const send = screen.getByRole('button', { name: 'Send message' })

    expect(send).toBeDisabled()
    await user.type(input, '   ')
    expect(send).toBeDisabled()
    await user.click(send)
    expect(onSend).not.toHaveBeenCalled()

    await user.type(input, 'Hello')
    expect(send).toBeEnabled()
    await user.clear(input)
    expect(send).toBeDisabled()
  })

  it.each(['click', 'Enter'])('submits a message using %s', async (method) => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<MessageComposer onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: 'Message' })
    await user.type(input, 'Hello from the composer')

    if (method === 'click') {
      await user.click(screen.getByRole('button', { name: 'Send message' }))
    } else {
      await user.keyboard('{Enter}')
    }

    expect(onSend).toHaveBeenCalledExactlyOnceWith('Hello from the composer')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('inserts a newline with Shift+Enter and sends the multiline draft', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<MessageComposer onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: 'Message' })

    await user.type(input, 'First line')
    await user.keyboard('{Shift>}{Enter}{/Shift}Second line')

    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('First line\nSecond line')

    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledExactlyOnceWith('First line\nSecond line')
  })
})
