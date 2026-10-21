import { Button, Group, Text, Title } from '@mantine/core'

import { AppHeader } from '../AppHeader/AppHeader'
import { Conversation } from '../Conversation/Conversation'
import { MessageComposer } from '../MessageComposer/MessageComposer'
import { PdfUpload } from '../PdfUpload/PdfUpload'
import { useChatWorkspace } from './useChatWorkspace'

import classes from './ChatWorkspace.module.css'

export function ChatWorkspace() {
  const {
    messages,
    sendMessage,
    pdfInfoOpened,
    openPdfInfo,
    closePdfInfo,
    upload,
  } = useChatWorkspace()

  const uploaded = upload.state.status === 'uploaded'

  return (
    <div className={classes.workspace}>
      <AppHeader />

      <main className={classes.chat}>
        <Group justify="space-between" gap="sm" className={classes.toolbar}>
          <div className={classes.document}>
            <Title order={2} size="h3">Conversation</Title>

            {uploaded && (
              <Text size="sm" fw={500} mt="sm" className={classes.filename}>
                {upload.state.file?.name}
              </Text>
            )}

            <Text size="sm" c="gray.7" mt={4} role="status">
              {uploaded ? 'Uploaded; not ready for questions.' : 'No PDF uploaded'}
            </Text>
          </div>

          <Button variant="default" onClick={openPdfInfo} aria-haspopup="dialog">
            {uploaded ? 'View upload' : 'Add PDF'}
          </Button>
        </Group>

        <Conversation messages={messages} />
        <MessageComposer onSend={sendMessage} />
      </main>

      <PdfUpload opened={pdfInfoOpened} onClose={closePdfInfo} upload={upload} />
    </div>
  )
}
