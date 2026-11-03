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
  MessageComposer: ({ onSend, disabled }: MessageComposerProps) => (
    <button type="button" disabled={disabled} onClick={() => onSend('A workspace message')}>
      Send mocked message
    </button>
  ),
}))

vi.mock('../PdfUploadDialog/PdfUploadDialog', () => ({
  PdfUploadDialog: ({ opened, onClose, onUploadSuccess }: PdfUploadDialogProps) => opened ? (
    <div role="dialog" aria-label="Mock PDF information">
      <button type="button" onClick={onClose}>Close mocked PDF information</button>
        <button type="button" onClick={() => onUploadSuccess?.({
          fileName: 'source.pdf', uploadId: 'upload-123',
          status: { uploadId: 'upload-123', status: 'queued', updatedAt: '2026-01-01T00:00:00.000Z', error: null },
        })}>
          Simulate PDF upload
        </button>
        <button type="button" onClick={() => onUploadSuccess?.({
          fileName: 'checked.pdf', uploadId: 'upload-checked',
          status: { uploadId: 'upload-checked', status: 'source_checked', updatedAt: '2026-01-01T00:00:00.000Z', error: null },
        })}>
          Simulate checked PDF
        </button>
        <button type="button" onClick={() => onUploadSuccess?.({
          fileName: 'processing.pdf', uploadId: 'upload-processing',
          status: { uploadId: 'upload-processing', status: 'processing', updatedAt: '2026-01-01T00:00:00.000Z', error: null },
        })}>
          Simulate processing PDF
        </button>
        <button type="button" onClick={() => onUploadSuccess?.({
          fileName: 'failed.pdf', uploadId: 'upload-failed',
          status: { uploadId: 'upload-failed', status: 'failed', updatedAt: '2026-01-01T00:00:00.000Z', error: 'safe failure' },
        })}>
          Simulate failed PDF
        </button>
    </div>
  ) : null,
}))

describe('ChatWorkspace', () => {
  it('renders the workspace shell with messaging unavailable', async () => {
    render(<ChatWorkspace />)

    expect(screen.getByRole('heading', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByText('No PDF attached')).toBeInTheDocument()
    expect(screen.getByRole('banner', { name: 'Mock app header' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send mocked message' })).toBeDisabled()
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

    expect(screen.getByText('source.pdf · Queued for document checks')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'PDF uploaded' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send mocked message' })).toBeDisabled()
  })

  it('keeps chat disabled when a source object has been checked', async () => {
    const user = userEvent.setup()
    render(<ChatWorkspace />)

    await user.click(screen.getByRole('button', { name: 'Add PDF' }))
    await user.click(screen.getByRole('button', { name: 'Simulate checked PDF' }))

    expect(screen.getByText('checked.pdf · Upload checked; document preparation pending.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send mocked message' })).toBeDisabled()
  })

  it.each([
    ['processing', 'processing.pdf · Document checks are in progress'],
    ['failed', 'failed.pdf · Document checks failed: safe failure'],
  ])('reports %s and keeps chat unavailable', async (_status, copy) => {
    const user = userEvent.setup()
    render(<ChatWorkspace />)

    await user.click(screen.getByRole('button', { name: 'Add PDF' }))
    await user.click(screen.getByRole('button', { name: _status === 'processing' ? 'Simulate processing PDF' : 'Simulate failed PDF' }))

    expect(screen.getByText(copy)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send mocked message' })).toBeDisabled()
  })
})
