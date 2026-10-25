import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { render } from '../../test/render'
import type { MessageComposerProps } from './MessageComposer.types'
import { useMessageComposer } from './useMessageComposer'

function ComposerHarness({ onSend }: MessageComposerProps) {
  const { draft, setDraft, inputRef, sendMessage, handleComposerKeyDown } = useMessageComposer(onSend)

  return (
    <form aria-label="Test composer" onSubmit={sendMessage}>
      <textarea
        aria-label="Draft"
        ref={inputRef}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={handleComposerKeyDown}
      />
      <button type="submit">Submit</button>
    </form>
  )
}

describe('useMessageComposer', () => {
  it('trims submitted text, clears the draft, and returns focus to the input', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<ComposerHarness onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: 'Draft' })

    fireEvent.change(input, { target: { value: '  First line\nSecond line  ' } })
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSend).toHaveBeenCalledExactlyOnceWith('First line\nSecond line')
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
  })

  it.each(['', '   \n\t'])('rejects a blank draft %j even on direct form submission', (draft) => {
    const onSend = vi.fn()
    render(<ComposerHarness onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.change(input, { target: { value: draft } })

    expect(fireEvent.submit(screen.getByRole('form', { name: 'Test composer' }))).toBe(false)

    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue(draft)
  })

  it.each([
    ['Shift+Enter', { key: 'Enter', shiftKey: true }],
    ['Control+Enter', { key: 'Enter', ctrlKey: true }],
    ['Alt+Enter', { key: 'Enter', altKey: true }],
    ['Meta+Enter', { key: 'Enter', metaKey: true }],
    ['IME composition', { key: 'Enter', isComposing: true }],
    ['legacy IME key code', { key: 'Enter', keyCode: 229 }],
    ['another key', { key: 'ArrowLeft' }],
  ])('leaves %s to the browser without submitting', (_name, event) => {
    const onSend = vi.fn()
    render(<ComposerHarness onSend={onSend} />)
    const input = screen.getByRole('textbox', { name: 'Draft' })
    fireEvent.change(input, { target: { value: 'Unsent draft' } })

    expect(fireEvent.keyDown(input, event)).toBe(true)

    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('Unsent draft')
  })
})
