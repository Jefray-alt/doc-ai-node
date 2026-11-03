import { Button, Group, Text, Title } from '@mantine/core'
import { AppHeader } from '../AppHeader/AppHeader'
import { Conversation } from '../Conversation/Conversation'
import { MessageComposer } from '../MessageComposer/MessageComposer'
import { PdfUploadDialog } from '../PdfUploadDialog/PdfUploadDialog'
import type { UploadJobState } from '../PdfUploadDialog/UploadJob.types'
import { useChatWorkspace } from './useChatWorkspace'
import { useUploadStatus } from './useUploadStatus'
import classes from './ChatWorkspace.module.css'

export function ChatWorkspace() {
  const {
    messages,
    sendMessage,
    uploadedPdfName,
    uploadedPdf,
    pdfInfoOpened,
    openPdfInfo,
    closePdfInfo,
    handlePdfUploaded,
  } = useChatWorkspace()
  const { status: jobStatus, connectionError } = useUploadStatus(uploadedPdf?.status ?? null)

  return (
    <div className={classes.workspace}>
      <AppHeader />
      <main className={classes.chat}>
        <Group justify="space-between" gap="sm" className={classes.toolbar}>
          <div>
            <Title order={2} size="h3">Conversation</Title>
            <Text size="sm" c="gray.7" mt={4}>
              {uploadedPdfName
                ? `${uploadedPdfName} · ${jobStatus ? workspaceStatusCopy(jobStatus.status, jobStatus.error, connectionError) : 'Confirmation pending'}`
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
        <MessageComposer onSend={sendMessage} disabled />
      </main>
      <PdfUploadDialog
        opened={pdfInfoOpened}
        onClose={closePdfInfo}
        onUploadSuccess={handlePdfUploaded}
      />
    </div>
  )
}

function workspaceStatusCopy(status: UploadJobState, error: string | null, connectionError: boolean) {
  switch (status) {
    case 'queued': return connectionError ? 'Queued; reconnecting to status' : 'Queued for document checks'
    case 'processing': return connectionError ? 'Checks in progress; reconnecting to status' : 'Document checks are in progress'
    case 'source_checked': return 'Upload checked; document preparation pending.'
    case 'failed': return error ? `Document checks failed: ${error}` : 'Document checks failed'
  }
}
