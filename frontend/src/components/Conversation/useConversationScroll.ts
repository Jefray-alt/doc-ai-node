import { useEffect, useRef } from 'react'
import type { ConversationProps } from './Conversation.types'

export function useConversationScroll(messages: ConversationProps['messages']) {
  const conversationRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const conversation = conversationRef.current
    if (conversation) {
      conversation.scrollTop = conversation.scrollHeight
    }
  }, [messages])

  return conversationRef
}
