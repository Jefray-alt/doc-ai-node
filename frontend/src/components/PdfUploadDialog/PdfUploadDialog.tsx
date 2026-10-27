import { Button, Group, Modal, Stack, Text } from '@mantine/core'
import type { ChangeEvent } from 'react'
import type { PdfUploadDialogProps } from './PdfUploadDialog.types'
import { usePdfUpload } from './usePdfUpload'
import classes from './PdfUploadDialog.module.css'

export function PdfUploadDialog({ opened, onClose, onUploadSuccess }: PdfUploadDialogProps) {
  const { file, status, errorMessage, selectFile, uploadFile } = usePdfUpload(onUploadSuccess)

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.currentTarget.files?.[0] ?? null)
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Add a PDF"
      centered
      size="sm"
      padding="lg"
      shadow="0 2px 8px rgba(0, 0, 0, 0.1)"
      transitionProps={{ transition: 'fade', duration: 150 }}
      closeButtonProps={{ 'aria-label': 'Close PDF information' }}
    >
      <Stack gap="md">
        {status === 'success' ? (
          <Text role="status">Uploaded, awaiting validation</Text>
        ) : (
          <>
            <label htmlFor="pdf-file">Choose a PDF</label>
            <input
              className={classes.fileInput}
              id="pdf-file"
              type="file"
              accept=".pdf,application/pdf"
              onChange={handleFileChange}
              disabled={status === 'uploading'}
            />
            {file && <Text size="sm">{file.name}</Text>}
            {errorMessage && <Text role="alert" c="red">{errorMessage}</Text>}
          </>
        )}
        <Group justify="flex-end" mt="sm">
          {status !== 'success' && (
            <Button
              onClick={() => void uploadFile()}
              disabled={!file || status === 'uploading'}
            >
              {status === 'uploading'
                ? 'Uploading PDF'
                : status === 'error' ? 'Retry upload' : 'Upload PDF'}
            </Button>
          )}
          <Button variant="default" onClick={onClose}>
            {status === 'success' ? 'Done' : 'Close'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
