import { useState } from 'react'
import { useDisclosure } from '@mantine/hooks'
import type { Message } from '../ChatMessage/ChatMessage.types'

export function useChatWorkspace() {
  const [messages, setMessages] = useState<Message[]>([])
  const [pdfInfoOpened, { open: openPdfInfo, close: closePdfInfo }] = useDisclosure(false)

  function sendMessage(text: string) {
    setMessages((current) => [...current, { id: current.length + 1, text }])
  }

  return { messages, sendMessage, pdfInfoOpened, openPdfInfo, closePdfInfo }
}
