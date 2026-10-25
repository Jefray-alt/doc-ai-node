import { MantineProvider } from '@mantine/core'
import type { PropsWithChildren } from 'react'
import { theme } from '../config/theme'

export function TestProviders({ children }: PropsWithChildren) {
  return (
    <MantineProvider theme={theme} forceColorScheme="light" env="test">
      {children}
    </MantineProvider>
  )
}
