import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '../../test/render'
import { PdfUploadDialog } from './PdfUploadDialog'

const file = new File(['%PDF-1.7 sample'], 'report.pdf', { type: 'application/pdf' })
const invalidFile = new File(['text'], 'notes.txt', { type: 'text/plain' })

function presignResponse() {
  return {
    uploadId: 'upload-123',
    url: 'http://localhost:4566/doc-ai-local-quarantine',
    fields: { key: 'incoming/upload-123.pdf', Policy: 'signed-policy' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

afterEach(() => vi.unstubAllGlobals())

function ControlledDialog({ onUploadSuccess }: { onUploadSuccess?: (fileName: string) => void }) {
  const [opened, setOpened] = useState(true)

  return (
    <>
      <button onClick={() => setOpened(true)}>Reopen dialog</button>
      <button onClick={() => setOpened(false)}>Close externally</button>
      <PdfUploadDialog
        opened={opened}
        onClose={() => setOpened(false)}
        onUploadSuccess={onUploadSuccess}
      />
    </>
  )
}

describe('PdfUploadDialog', () => {
  it('offers a PDF file picker when opened', () => {
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Add a PDF' })).toBeInTheDocument()
    expect(screen.getByLabelText('Choose a PDF')).toHaveAttribute('accept', '.pdf,application/pdf')
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
  })

  it('requests permission and posts the file directly to quarantine', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))

    expect(await screen.findByText('Uploaded, awaiting validation')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/uploads/presign', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'report.pdf', contentType: 'application/pdf', sizeBytes: file.size }),
    }))
    const [url, options] = fetchMock.mock.calls[1]
    expect(url).toBe('http://localhost:4566/doc-ai-local-quarantine')
    expect(options.method).toBe('POST')
    expect(options.body).toBeInstanceOf(FormData)
    expect(options.body.get('key')).toBe('incoming/upload-123.pdf')
    const uploadedFile = options.body.get('file') as File
    expect(uploadedFile.name).toBe(file.name)
    expect(uploadedFile.type).toBe(file.type)
    expect(await uploadedFile.text()).toBe(await file.text())
  })

  it('clears a selected file when the dialog closes and reopens', async () => {
    const user = userEvent.setup()
    render(<ControlledDialog />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Reopen dialog' }))

    expect(screen.getByLabelText('Choose a PDF')).toHaveValue('')
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeEnabled()
  })

  it.each(['close icon', 'Escape'])('resets the dialog when closed with %s', async (method) => {
    const user = userEvent.setup()
    render(<ControlledDialog />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    if (method === 'close icon') {
      await user.click(screen.getByRole('button', { name: 'Close PDF upload' }))
    } else {
      await user.keyboard('{Escape}')
    }
    await user.click(screen.getByRole('button', { name: 'Reopen dialog' }))

    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
    expect(screen.queryByText('report.pdf')).not.toBeInTheDocument()
  })

  it('clears validation errors when the parent closes and reopens the dialog', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<ControlledDialog />)

    await user.upload(screen.getByLabelText('Choose a PDF'), invalidFile)
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF file.')
    await user.click(screen.getByRole('button', { name: 'Close externally' }))
    await user.click(screen.getByRole('button', { name: 'Reopen dialog' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Choose a PDF')).toHaveAttribute('aria-invalid', 'false')
  })

  it('clears upload errors when the dialog closes and reopens', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockResolvedValueOnce({ ok: false })
    vi.stubGlobal('fetch', fetchMock)
    render(<ControlledDialog />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed. Please try again.')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Reopen dialog' }))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
  })

  it('clears success when Done closes and reopens the dialog', async () => {
    const user = userEvent.setup()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockResolvedValueOnce({ ok: true }))
    render(<ControlledDialog />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    expect(await screen.findByText('Uploaded, awaiting validation')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await user.click(screen.getByRole('button', { name: 'Reopen dialog' }))

    expect(screen.queryByText('Uploaded, awaiting validation')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
  })

  it('does not start storage upload when authorization resolves after close', async () => {
    const user = userEvent.setup()
    let resolveAuthorization!: (response: { ok: boolean; json: () => Promise<ReturnType<typeof presignResponse>> }) => void
    const fetchMock = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveAuthorization = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ControlledDialog />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Reopen dialog' }))
    resolveAuthorization({ ok: true, json: async () => presignResponse() })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
  })

  it('ignores stale upload rejection after close and preserves the new session', async () => {
    const user = userEvent.setup()
    let rejectAuthorization!: (error: Error) => void
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectAuthorization = reject }))
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const onUploadSuccess = vi.fn()
    render(<ControlledDialog onUploadSuccess={onUploadSuccess} />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Reopen dialog' }))
    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    rejectAuthorization(new Error('late authorization failure'))

    expect(await screen.findByText('Uploaded, awaiting validation')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onUploadSuccess).toHaveBeenCalledExactlyOnceWith('report.pdf')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not publish a stale storage success after a new session succeeds', async () => {
    const user = userEvent.setup()
    let resolveOldStorage!: (response: { ok: boolean }) => void
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldStorage = resolve }))
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const onUploadSuccess = vi.fn()
    render(<ControlledDialog onUploadSuccess={onUploadSuccess} />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByRole('button', { name: 'Reopen dialog' }))
    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    expect(await screen.findByText('Uploaded, awaiting validation')).toBeInTheDocument()
    expect(onUploadSuccess).toHaveBeenCalledExactlyOnceWith('report.pdf')

    resolveOldStorage({ ok: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(onUploadSuccess).toHaveBeenCalledExactlyOnceWith('report.pdf')
    expect(screen.getByText('Uploaded, awaiting validation')).toBeInTheDocument()
  })

  it('reports a specific error for a non-PDF selection before contacting the API', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    await user.upload(
      screen.getByLabelText('Choose a PDF'),
      new File(['text'], 'notes.txt', { type: 'text/plain' }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF file.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    new File(['text'], 'notes.pdf', { type: 'text/plain' }),
    new File(['text'], 'notes.txt', { type: 'application/pdf' }),
  ])('requires both PDF MIME type and a .pdf filename', async (invalidFile) => {
    const user = userEvent.setup({ applyAccept: false })
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    await user.upload(screen.getByLabelText('Choose a PDF'), invalidFile)

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF file.')
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
  })

  it('reports when an otherwise valid PDF is empty', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    await user.upload(
      screen.getByLabelText('Choose a PDF'),
      new File([], 'empty.pdf', { type: 'application/pdf' }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent('The PDF file is empty.')
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
  })

  it('reports when a PDF exceeds the 20 MiB limit', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    await user.upload(
      screen.getByLabelText('Choose a PDF'),
      new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'large.pdf', { type: 'application/pdf' }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent('PDF files must be no larger than 20 MiB.')
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeDisabled()
  })

  it('accepts PDF files at both size boundaries and a case-insensitive extension', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<PdfUploadDialog opened onClose={vi.fn()} />)
    const picker = screen.getByLabelText('Choose a PDF')

    await user.upload(picker, new File(['x'], 'tiny.PDF', { type: 'application/pdf' }))
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await user.upload(
      picker,
      new File([new Uint8Array(20 * 1024 * 1024)], 'maximum.pdf', { type: 'application/pdf' }),
    )
    expect(screen.getByRole('button', { name: 'Upload PDF' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the selected file available for retry after a failed storage upload', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockResolvedValueOnce({ ok: false, text: async () => 'storage error' })
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed. Please try again.')

    await user.click(screen.getByRole('button', { name: 'Retry upload' }))
    expect(await screen.findByText('Uploaded, awaiting validation')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('disables submission while an upload is in progress', async () => {
    const user = userEvent.setup()
    let resolveUpload!: (response: { ok: boolean }) => void
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => presignResponse() })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    await user.upload(screen.getByLabelText('Choose a PDF'), file)
    await user.click(screen.getByRole('button', { name: 'Upload PDF' }))
    expect(screen.getByRole('button', { name: 'Uploading PDF' })).toBeDisabled()
    resolveUpload({ ok: true })
    expect(await screen.findByText('Uploaded, awaiting validation')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
