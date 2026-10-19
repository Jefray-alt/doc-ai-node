import { Button, Group, Text, Title } from '@mantine/core'
import { AppHeader } from '../AppHeader/AppHeader'
import { Conversation } from '../Conversation/Conversation'
import { MessageComposer } from '../MessageComposer/MessageComposer'
import { PdfAvailabilityModal } from '../PdfAvailabilityModal/PdfAvailabilityModal'
import { useChatWorkspace } from './useChatWorkspace'
import classes from './ChatWorkspace.module.css'

export function ChatWorkspace() {
  const { messages, sendMessage, pdfInfoOpened, openPdfInfo, closePdfInfo } = useChatWorkspace()

  return (
    <div className={classes.workspace}>
      <AppHeader />
      <main className={classes.chat}>
        <Group justify="space-between" gap="sm" className={classes.toolbar}>
          <div>
            <Title order={2} size="h3">Conversation</Title>
            <Text size="sm" c="gray.7" mt={4}>No PDF attached</Text>
          </div>
          <Button variant="default" onClick={openPdfInfo} aria-haspopup="dialog">
            Add PDF
          </Button>
        </Group>
        <Conversation messages={messages} />
        <MessageComposer onSend={sendMessage} />
      </main>
      <PdfAvailabilityModal opened={pdfInfoOpened} onClose={closePdfInfo} />
    </div>
  )
}
