import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '../../test/render'
import { PdfUploadDialog } from './PdfUploadDialog'

const file = new File(['%PDF-1.7 sample'], 'report.pdf', { type: 'application/pdf' })

function presignResponse() {
  return {
    uploadId: 'upload-123',
    url: 'http://localhost:4566/doc-ai-local-quarantine',
    fields: { key: 'incoming/upload-123.pdf', Policy: 'signed-policy' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
}

afterEach(() => vi.unstubAllGlobals())

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

  it('rejects a non-PDF selection before contacting the API', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<PdfUploadDialog opened onClose={vi.fn()} />)

    await user.upload(
      screen.getByLabelText('Choose a PDF'),
      new File(['text'], 'notes.txt', { type: 'text/plain' }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Choose a PDF file no larger than 20 MiB.')
    expect(fetchMock).not.toHaveBeenCalled()
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
