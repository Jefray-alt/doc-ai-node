import { Text } from '@mantine/core'
import type { ChatMessageProps } from './ChatMessage.types'
import classes from './ChatMessage.module.css'

export function ChatMessage({ message }: ChatMessageProps) {
  return (
    <article className={classes.message} data-testid="chat-message">
      <Text component="h3" size="sm" fw={600} mb={8}>You</Text>
      <Text component="p" className={classes.messageText}>{message.text}</Text>
    </article>
  )
}
