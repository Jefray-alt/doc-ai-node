// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { MantineProvider } from '@mantine/core'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ChatWorkspace } from '../src/components/ChatWorkspace/ChatWorkspace'
import {
  requestUploadAuthorization,
  uploadFileToStorage,
} from '../src/components/PdfUpload/uploadTransport'
import { theme } from '../src/config/theme'

import type { UploadAuthorization } from '../src/components/PdfUpload/PdfUpload.types'

vi.mock('../src/components/PdfUpload/uploadTransport', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/components/PdfUpload/uploadTransport')>(),
  requestUploadAuthorization: vi.fn(),
  uploadFileToStorage: vi.fn(),
}))

const authorizations: ReturnType<typeof Promise.withResolvers<UploadAuthorization>>[] = []
const transfers: ReturnType<typeof Promise.withResolvers<void>>[] = []

const authorization: UploadAuthorization = {
  uploadId: 'test-upload',
  method: 'PUT',
  url: 'https://storage.example.test/upload.pdf',
  headers: {
    'Content-Type': 'application/pdf',
  },
  expiresAt: '2026-10-21T00:05:00.000Z',
}

const file = new File(['%PDF-1.7\nexample'], 'notes.pdf', {
  type: 'application/pdf',
})

beforeEach(() => {
  vi.resetAllMocks()

  authorizations.length = 0
  transfers.length = 0

  vi.mocked(requestUploadAuthorization).mockImplementation(() => {
    const pending = Promise.withResolvers<UploadAuthorization>()

    authorizations.push(pending)

    return pending.promise
  })

  vi.mocked(uploadFileToStorage).mockImplementation(() => {
    const pending = Promise.withResolvers<void>()

    transfers.push(pending)

    return pending.promise
  })

  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))

  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: new EventTarget(),
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderWorkspace() {
  return render(
    <MantineProvider theme={theme} env="test">
      <ChatWorkspace />
    </MantineProvider>,
  )
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: 'Add PDF' }))

  return screen.findByRole('dialog', { name: 'Add a PDF' })
}

function select(dialog: HTMLElement, candidate = file) {
  fireEvent.change(dialog.querySelector('input[type="file"]')!, {
    target: {
      files: [candidate],
    },
  })
}

async function start() {
  renderWorkspace()

  const dialog = await openPicker()

  select(dialog)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Upload PDF' }))

  return dialog
}

async function authorize(index = 0) {
  await act(async () => authorizations[index].resolve(authorization))
}

async function complete(index = 0) {
  await act(async () => transfers[index].resolve())
}

it('offers an accessible single-PDF picker and an explicit upload action', async () => {
  renderWorkspace()

  const dialog = await openPicker()

  const picker = within(dialog).queryByRole('button', { name: 'PDF file' })

  expect(picker, 'Add PDF must provide a labelled file picker').not.toBeNull()
  expect(within(dialog).getByRole('button', { name: 'Upload PDF' }).hasAttribute('disabled')).toBe(true)

  const input = dialog.querySelector('input[type="file"]')!

  expect(input.getAttribute('accept')).toBe('.pdf,application/pdf')
  expect(input.hasAttribute('multiple')).toBe(false)

  select(dialog)

  expect(within(dialog).getByRole('button', { name: 'Upload PDF' }).hasAttribute('disabled')).toBe(false)
  expect(within(dialog).getByRole('button', { name: 'PDF file' }).textContent).toBe('notes.pdf')
  expect(requestUploadAuthorization).not.toHaveBeenCalled()
})

it.each([
  ['bad.txt', 'application/pdf', 1, '.pdf filename'],
  ['empty.pdf', 'application/pdf', 0, 'nonempty PDF'],
  ['large.pdf', 'application/pdf', 10 * 1024 * 1024 + 1, '10 MiB'],
  ['bad.pdf', 'text/plain', 1, 'media type'],
])('explains invalid selection %s without authorizing, then allows correction', async (name, type, size, message) => {
  renderWorkspace()

  const dialog = await openPicker()
  const candidate = new File(['x'], name as string, {
    type: type as string,
  })

  Object.defineProperty(candidate, 'size', {
    value: size,
  })

  select(dialog, candidate)

  expect(within(dialog).getByRole('alert').textContent).toContain(message)
  expect(within(dialog).getByRole('button', { name: 'PDF file' }).getAttribute('aria-invalid')).toBe('true')
  expect(within(dialog).getByRole('button', { name: 'Upload PDF' }).hasAttribute('disabled')).toBe(true)
  expect(requestUploadAuthorization).not.toHaveBeenCalled()

  select(dialog)

  expect(within(dialog).queryByRole('alert')).toBeNull()
  expect(within(dialog).getByRole('button', { name: 'Upload PDF' }).hasAttribute('disabled')).toBe(false)
})

it('shows authorization, indeterminate transfer, percentages and storage confirmation in order', async () => {
  const dialog = await start()
  const view = within(dialog)

  expect(view.getByRole('status').textContent).toContain('Requesting upload authorization')
  expect(view.getByRole('button', { name: 'PDF file' }).hasAttribute('disabled')).toBe(true)
  expect(view.queryByRole('button', { name: 'Upload PDF' })).toBeNull()
  expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()

  await authorize()

  expect(view.getByRole('status').textContent).toContain('Progress is not available yet')
  expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  expect(view.getByRole('button', { name: 'PDF file' }).hasAttribute('disabled')).toBe(true)

  const options = vi.mocked(uploadFileToStorage).mock.calls[0][2]

  act(() => options.onProgress?.({
    loaded: file.size / 2,
    total: file.size,
  }))

  expect(view.getByRole('progressbar', { name: 'PDF upload progress' }).getAttribute('aria-valuenow')).toBe('50')
  expect(view.getByRole('status').textContent).toContain('50% transferred')

  act(() => options.onProgress?.({
    loaded: file.size,
    total: file.size,
  }))

  expect(view.getByRole('status').textContent).toContain('Waiting for storage confirmation')
  expect(view.queryByText('Uploaded; not ready for questions.')).toBeNull()

  await complete()

  expect(view.getByRole('status').textContent).toBe('Uploaded; not ready for questions.')
  expect(view.queryByRole('progressbar')).toBeNull()
  expect(view.queryByRole('button', { name: 'Cancel upload' })).toBeNull()
})

it.each(['authorization', 'storage'])('cancels %s through the cancel action and offers a fresh retry', async (phase) => {
  const dialog = await start()
  const view = within(dialog)

  if (phase === 'storage') {
    await authorize()
  }

  const signal = vi.mocked(requestUploadAuthorization).mock.calls[0][1].signal

  fireEvent.click(view.getByRole('button', { name: 'Cancel upload' }))

  expect(signal.aborted).toBe(true)
  expect(view.getByRole('status').textContent).toContain('Upload cancelled')
  expect(view.getByText(/Cancellation does not guarantee deletion/)).toBeTruthy()
  expect(view.getByRole('button', { name: 'PDF file' }).hasAttribute('disabled')).toBe(false)

  await act(async () => {
    if (phase === 'storage') {
      transfers[0].resolve()
    } else {
      authorizations[0].resolve(authorization)
    }
  })

  expect(view.getByRole('status').textContent).toContain('Upload cancelled')

  fireEvent.click(view.getByRole('button', { name: 'Retry upload' }))

  expect(requestUploadAuthorization).toHaveBeenCalledTimes(2)
  expect(vi.mocked(requestUploadAuthorization).mock.calls[1][1].signal).not.toBe(signal)
  expect(view.getByRole('status').textContent).toContain('Requesting upload authorization')
})

it.each(['authorization', 'storage'])('reports safe %s failure and retries to completion', async (phase) => {
  const dialog = await start()
  const view = within(dialog)

  if (phase === 'storage') {
    await authorize()
  }

  await act(async () => {
    const pending = phase === 'storage' ? transfers[0] : authorizations[0]

    pending.reject(new Error('private transport diagnostic'))
  })

  expect(view.getByRole('alert').textContent).toContain(phase === 'storage'
    ? 'Could not upload the PDF to storage'
    : 'Could not authorize the upload')

  expect(dialog.textContent).not.toContain('private transport diagnostic')
  expect(view.getByRole('button', { name: 'PDF file' }).hasAttribute('disabled')).toBe(false)

  fireEvent.click(view.getByRole('button', { name: 'Retry upload' }))

  expect(view.queryByRole('alert')).toBeNull()
  expect(requestUploadAuthorization).toHaveBeenCalledTimes(2)

  await authorize(1)
  await complete(phase === 'storage' ? 1 : 0)

  expect(view.getByRole('status').textContent).toBe('Uploaded; not ready for questions.')
})

it.each([
  ['authorization', 'Close PDF upload'],
  ['storage', 'Close'],
  ['storage', 'Escape'],
])('cancels %s before closing with %s and retains cancellation on reopen', async (phase, closeAction) => {
  const dialog = await start()

  if (phase === 'storage') {
    await authorize()
  }

  const signal = vi.mocked(requestUploadAuthorization).mock.calls[0][1].signal

  if (closeAction === 'Escape') {
    fireEvent.keyDown(dialog, {
      key: 'Escape',
      code: 'Escape',
    })
  } else {
    fireEvent.click(within(dialog).getByRole('button', { name: closeAction }))
  }

  expect(signal.aborted).toBe(true)

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  const reopened = await openPicker()

  expect(within(reopened).getByRole('status').textContent).toContain('Upload cancelled')
  expect(within(reopened).getByRole('button', { name: 'PDF file' }).textContent).toBe('notes.pdf')
  expect(within(reopened).getByRole('button', { name: 'Retry upload' })).toBeTruthy()
})

it('retains the uploaded filename and readiness boundary on close, preserves chat, and resets on a fresh workspace', async () => {
  const dialog = await start()

  await authorize()
  await complete()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  const main = within(screen.getByRole('main'))

  expect(main.getByText('notes.pdf')).toBeTruthy()
  expect(main.getByRole('status').textContent).toBe('Uploaded; not ready for questions.')
  expect(main.queryByRole('button', { name: 'Add PDF' })).toBeNull()

  fireEvent.change(main.getByRole('textbox', { name: 'Message' }), {
    target: {
      value: 'A question for later',
    },
  })

  fireEvent.submit(main.getByRole('form', { name: 'Message composer' }))

  expect(main.getByRole('log').textContent).toBe('YouA question for later')
  expect((main.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('')
  expect(main.getByText('notes.pdf')).toBeTruthy()

  fireEvent.click(main.getByRole('button', { name: 'View upload' }))

  const reopened = within(await screen.findByRole('dialog', { name: 'Add a PDF' }))

  expect(reopened.getByRole('button', { name: 'PDF file' }).hasAttribute('disabled')).toBe(true)
  expect(reopened.queryByRole('button', { name: 'Upload PDF' })).toBeNull()
  expect(reopened.queryByRole('button', { name: 'Retry upload' })).toBeNull()
  expect(requestUploadAuthorization).toHaveBeenCalledOnce()

  cleanup()
  renderWorkspace()

  expect(screen.getByRole('status').textContent).toBe('No PDF uploaded')
  expect(screen.getByRole('log').textContent).toContain('No messages yet')

  const fresh = await openPicker()

  select(fresh, new File(['second'], 'second.PDF'))
  fireEvent.click(within(fresh).getByRole('button', { name: 'Upload PDF' }))

  expect(requestUploadAuthorization).toHaveBeenCalledTimes(2)
  expect(vi.mocked(requestUploadAuthorization).mock.calls[1][0].contentType).toBe('application/pdf')
})

it('documents the rendered upload controls and refresh behavior', () => {
  const documentation = readFileSync('README.md', 'utf8')

  expect(documentation).toContain('Add PDF')
  expect(documentation).toContain('PDF file')
  expect(documentation).toContain('Upload PDF')
  expect(documentation).toContain('Cancel upload')
  expect(documentation).toContain('Retry upload')
  expect(documentation).toContain('View upload')
  expect(documentation).toContain('Uploaded; not ready for questions')
  expect(documentation).toContain('Refresh or remount clears this in-memory state')
})
