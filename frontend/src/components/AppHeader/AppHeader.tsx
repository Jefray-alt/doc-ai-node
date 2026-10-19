import { Title } from '@mantine/core'
import classes from './AppHeader.module.css'

export function AppHeader() {
  return (
    <header className={classes.header}>
      <div className={classes.headerInner}>
        <Title order={1} size="h4">Document Chat</Title>
      </div>
    </header>
  )
}
