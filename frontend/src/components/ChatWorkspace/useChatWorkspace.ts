import { useState } from 'react'
import { useDisclosure } from '@mantine/hooks'
import type { Message } from '../ChatMessage/ChatMessage.types'

export function useChatWorkspace() {
  const [messages, setMessages] = useState<Message[]>([])
  const [uploadedPdfName, setUploadedPdfName] = useState<string | null>(null)
  const [pdfInfoOpened, { open: openPdfInfo, close: closePdfInfo }] = useDisclosure(false)

  function sendMessage(text: string) {
    setMessages((current) => [...current, { id: current.length + 1, text }])
  }

  function handlePdfUploaded(fileName: string) {
    setUploadedPdfName(fileName)
    closePdfInfo()
  }

  return {
    messages,
    sendMessage,
    uploadedPdfName,
    pdfInfoOpened,
    openPdfInfo,
    closePdfInfo,
    handlePdfUploaded,
  }
}
