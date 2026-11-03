import { useState } from 'react'
import { useDisclosure } from '@mantine/hooks'
import type { Message } from '../ChatMessage/ChatMessage.types'
import type { UploadedPdf } from '../PdfUploadDialog/UploadJob.types'

export function useChatWorkspace() {
  const [messages, setMessages] = useState<Message[]>([])
  const [uploadedPdfName, setUploadedPdfName] = useState<string | null>(null)
  const [pdfInfoOpened, { open: openPdfInfo, close: closePdfInfo }] = useDisclosure(false)

  function sendMessage(text: string) {
    setMessages((current) => [...current, { id: current.length + 1, text }])
  }

  function handlePdfUploaded(upload: UploadedPdf) {
    setUploadedPdfName(upload.fileName)
    setUploadedPdf(upload)
    closePdfInfo()
  }

  const [uploadedPdf, setUploadedPdf] = useState<UploadedPdf | null>(null)

  return {
    messages,
    sendMessage,
    uploadedPdfName,
    uploadedPdf,
    pdfInfoOpened,
    openPdfInfo,
    closePdfInfo,
    handlePdfUploaded,
  }
}
