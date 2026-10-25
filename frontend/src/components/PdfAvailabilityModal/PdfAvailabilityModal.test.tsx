import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { render } from '../../test/render'
import { PdfAvailabilityModal } from './PdfAvailabilityModal'

describe('PdfAvailabilityModal', () => {
  it('follows the opened prop and explains PDF availability', () => {
    const onClose = vi.fn()
    const { rerender } = render(<PdfAvailabilityModal opened={false} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    rerender(<PdfAvailabilityModal opened onClose={onClose} />)
    const dialog = screen.getByRole('dialog', { name: 'Add a PDF' })
    expect(within(dialog).getByText(/PDF upload is not available yet/)).toBeInTheDocument()
    expect(dialog).toHaveTextContent('answers will be available after PDF support is added')

    rerender(<PdfAvailabilityModal opened={false} onClose={onClose} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each(['Close', 'Close PDF information'])('calls onClose from the %s button', async (name) => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<PdfAvailabilityModal opened onClose={onClose} />)

    await user.click(screen.getByRole('button', { name }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('calls onClose on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<PdfAvailabilityModal opened onClose={onClose} />)

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledOnce()
  })
})
