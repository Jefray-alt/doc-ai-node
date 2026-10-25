import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(cleanup)

// Mantine uses browser APIs that jsdom does not implement.
const { getComputedStyle } = window
window.getComputedStyle = (element) => getComputedStyle(element)

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

if (!document.fonts) {
  Object.defineProperty(document, 'fonts', {
    value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  })
}
