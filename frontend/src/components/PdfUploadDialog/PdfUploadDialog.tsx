import { Button, Group, Modal, Text } from '@mantine/core'
import { useCallback, useLayoutEffect, useRef } from 'react'
import type { ChangeEvent } from 'react'
import type { PdfUploadDialogProps } from './PdfUploadDialog.types'
import { usePdfUpload } from './usePdfUpload'
import classes from './PdfUploadDialog.module.css'

export function PdfUploadDialog({ opened, onClose, onUploadSuccess }: PdfUploadDialogProps) {
  const { file, status, errorMessage, selectFile, uploadFile, resetSession } = usePdfUpload(onUploadSuccess)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const resetForClose = useCallback(() => {
    resetSession()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [resetSession])

  useLayoutEffect(() => {
    if (!opened) resetForClose()
  }, [opened, resetForClose])

  function handleClose() {
    resetForClose()
    onClose()
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.currentTarget.files?.[0] ?? null)
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Add a PDF"
      centered
      size={460}
      padding={0}
      classNames={{ header: classes.header, title: classes.title, body: classes.body }}
      shadow="0 2px 8px rgba(0, 0, 0, 0.1)"
      transitionProps={{ transition: 'fade', duration: 150 }}
      closeButtonProps={{ 'aria-label': 'Close PDF upload' }}
    >
      <div className={classes.content}>
        {status === 'success' ? (
          <div className={classes.success} role="status">
            <svg className={classes.successIcon} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="m5 12 4 4L19 6" />
            </svg>
            <div className={classes.fileDetails}>
              <Text fw={600}>Uploaded, awaiting validation</Text>
              <Text size="sm" c="dimmed" className={classes.fileName}>{file?.name}</Text>
            </div>
          </div>
        ) : (
          <>
            <Text size="sm" c="dimmed" mb="lg">
              Choose the document you want to add to this conversation.
            </Text>
            <div
              className={classes.filePicker}
              data-selected={Boolean(file) || undefined}
              data-disabled={status === 'uploading' || undefined}
              data-error={Boolean(errorMessage) || undefined}
            >
              <input
                className={classes.fileInput}
                id="pdf-file"
                ref={fileInputRef}
                type="file"
                aria-label="Choose a PDF"
                aria-describedby={errorMessage ? 'pdf-file-limits pdf-file-error' : 'pdf-file-limits'}
                aria-invalid={Boolean(errorMessage)}
                accept=".pdf,application/pdf"
                onChange={handleFileChange}
                disabled={status === 'uploading'}
              />
              <svg className={classes.documentIcon} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
                <path d="M14 3v6h6M8 13h8M8 17h5" />
              </svg>
              <div className={classes.fileDetails}>
                <Text fw={500} size="sm" className={classes.fileName}>
                  {file ? file.name : 'Choose a PDF'}
                </Text>
                <Text size="sm" c="dimmed" mt={4}>
                  {file
                    ? `PDF document · ${file.size < 1024 * 1024
                      ? `${Math.max(1, Math.ceil(file.size / 1024))} KiB`
                      : `${(file.size / (1024 * 1024)).toFixed(1)} MiB`}`
                    : 'Select a file from your device'}
                </Text>
              </div>
              <span className={classes.browse}>{file ? 'Change file' : 'Browse files'}</span>
            </div>
            <Text id="pdf-file-limits" size="xs" c="dimmed" mt="sm">
              PDF only · Up to 20 MiB · One file at a time
            </Text>
            {errorMessage && <Text id="pdf-file-error" role="alert" size="sm" c="red.8" mt="md">{errorMessage}</Text>}
          </>
        )}
      </div>
      <Group justify="flex-end" gap="sm" className={classes.footer}>
        <Button variant="default" onClick={handleClose}>
          {status === 'success' ? 'Done' : 'Close'}
        </Button>
        {status !== 'success' && (
          <Button
            onClick={() => void uploadFile()}
            disabled={!file || status === 'uploading'}
            loading={status === 'uploading'}
          >
            {status === 'uploading'
              ? 'Uploading PDF'
              : status === 'error' ? 'Retry upload' : 'Upload PDF'}
          </Button>
        )}
      </Group>
    </Modal>
  )
}
