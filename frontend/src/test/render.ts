import { render as testingLibraryRender } from '@testing-library/react'
import type { RenderOptions } from '@testing-library/react'
import type { ReactNode } from 'react'
import { TestProviders } from './TestProviders'

export function render(ui: ReactNode, options?: Omit<RenderOptions, 'wrapper'>) {
  return testingLibraryRender(ui, { ...options, wrapper: TestProviders })
}
