import { Button, Group, Text, Title } from '@mantine/core'
import { AppHeader } from '../AppHeader/AppHeader'
import { Conversation } from '../Conversation/Conversation'
import { MessageComposer } from '../MessageComposer/MessageComposer'
import { PdfUploadDialog } from '../PdfUploadDialog/PdfUploadDialog'
import { useChatWorkspace } from './useChatWorkspace'
import classes from './ChatWorkspace.module.css'

export function ChatWorkspace() {
  const {
    messages,
    sendMessage,
    uploadedPdfName,
    pdfInfoOpened,
    openPdfInfo,
    closePdfInfo,
    handlePdfUploaded,
  } = useChatWorkspace()

  return (
    <div className={classes.workspace}>
      <AppHeader />
      <main className={classes.chat}>
        <Group justify="space-between" gap="sm" className={classes.toolbar}>
          <div>
            <Title order={2} size="h3">Conversation</Title>
            <Text size="sm" c="gray.7" mt={4}>
              {uploadedPdfName
                ? `${uploadedPdfName} · Uploaded, awaiting validation`
                : 'No PDF attached'}
            </Text>
          </div>
          <Button
            variant="default"
            onClick={openPdfInfo}
            aria-haspopup="dialog"
            disabled={Boolean(uploadedPdfName)}
          >
            {uploadedPdfName ? 'PDF uploaded' : 'Add PDF'}
          </Button>
        </Group>
        <Conversation messages={messages} />
        <MessageComposer onSend={sendMessage} />
      </main>
      <PdfUploadDialog
        opened={pdfInfoOpened}
        onClose={closePdfInfo}
        onUploadSuccess={handlePdfUploaded}
      />
    </div>
  )
}
