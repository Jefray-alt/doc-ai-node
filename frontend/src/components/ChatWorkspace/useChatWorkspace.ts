import { useState } from 'react'
import { useDisclosure } from '@mantine/hooks'
import { usePdfUpload } from '../PdfUpload/usePdfUpload'
import type { Message } from '../ChatMessage/ChatMessage.types'

export function useChatWorkspace() {
  const [messages, setMessages] = useState<Message[]>([])
  const [pdfInfoOpened, { open: openPdfInfo, close }] = useDisclosure(false)
  const upload = usePdfUpload()

  function closePdfInfo() {
    upload.cancelUpload()
    close()
  }

  function sendMessage(text: string) {
    setMessages((current) => [...current, { id: current.length + 1, text }])
  }

  return {
    messages,
    sendMessage,
    pdfInfoOpened,
    openPdfInfo,
    closePdfInfo,
    upload,
  }
}
