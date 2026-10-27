import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { render } from '../../test/render'
import type { ConversationProps } from '../Conversation/Conversation.types'
import type { MessageComposerProps } from '../MessageComposer/MessageComposer.types'
import type { PdfUploadDialogProps } from '../PdfUploadDialog/PdfUploadDialog.types'
import { ChatWorkspace } from './ChatWorkspace'

vi.mock('../AppHeader/AppHeader', () => ({
  AppHeader: () => <header aria-label="Mock app header" />,
}))

vi.mock('../Conversation/Conversation', () => ({
  Conversation: ({ messages }: ConversationProps) => (
    <div role="log" aria-label="Mock conversation">
      {messages.map(({ id, text }) => <p key={id}>{text}</p>)}
    </div>
  ),
}))

vi.mock('../MessageComposer/MessageComposer', () => ({
  MessageComposer: ({ onSend }: MessageComposerProps) => (
    <button type="button" onClick={() => onSend('A workspace message')}>
      Send mocked message
    </button>
  ),
}))

vi.mock('../PdfUploadDialog/PdfUploadDialog', () => ({
  PdfUploadDialog: ({ opened, onClose, onUploadSuccess }: PdfUploadDialogProps) => opened ? (
    <div role="dialog" aria-label="Mock PDF information">
      <button type="button" onClick={onClose}>Close mocked PDF information</button>
        <button type="button" onClick={() => onUploadSuccess?.('source.pdf')}>
          Simulate PDF upload
        </button>
    </div>
  ) : null,
}))

describe('ChatWorkspace', () => {
  it('renders the workspace shell and displays messages sent by the composer', async () => {
    const user = userEvent.setup()
    render(<ChatWorkspace />)

    expect(screen.getByRole('heading', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByText('No PDF attached')).toBeInTheDocument()
    expect(screen.getByRole('banner', { name: 'Mock app header' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send mocked message' }))

    const log = screen.getByRole('log', { name: 'Mock conversation' })
    expect(within(log).getByText('A workspace message')).toBeInTheDocument()
  })

  it('opens and closes PDF information through the modal callback', async () => {
    const user = userEvent.setup()
    render(<ChatWorkspace />)
    const trigger = screen.getByRole('button', { name: 'Add PDF' })

    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Mock PDF information' })
    await user.click(within(dialog).getByRole('button', { name: 'Close mocked PDF information' }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows the uploaded PDF status and prevents attaching a second file', async () => {
    const user = userEvent.setup()
    render(<ChatWorkspace />)

    await user.click(screen.getByRole('button', { name: 'Add PDF' }))
    await user.click(screen.getByRole('button', { name: 'Simulate PDF upload' }))

    expect(screen.getByText('source.pdf · Uploaded, awaiting validation')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'PDF uploaded' })).toBeDisabled()
  })
})
