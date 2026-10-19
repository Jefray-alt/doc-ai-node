import { Stack, Text } from '@mantine/core'
import { ChatMessage } from '../ChatMessage/ChatMessage'
import type { ConversationProps } from './Conversation.types'
import { useConversationScroll } from './useConversationScroll'
import classes from './Conversation.module.css'

export function Conversation({ messages }: ConversationProps) {
  const conversationRef = useConversationScroll(messages)

  return (
    <div
      ref={conversationRef}
      className={classes.conversation}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      aria-relevant="additions text"
      tabIndex={0}
    >
      {messages.length === 0 ? (
        <Stack gap={8} align="center" className={classes.empty}>
          <Text fw={500}>No messages yet</Text>
          <Text size="sm" c="gray.7" ta="center">
            Write a message below to start this session.
          </Text>
        </Stack>
      ) : (
        messages.map((message) => <ChatMessage key={message.id} message={message} />)
      )}
    </div>
  )
}
