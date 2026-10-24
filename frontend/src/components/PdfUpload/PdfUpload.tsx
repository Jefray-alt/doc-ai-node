import { Button, FileInput, Group, Modal, Progress, Stack, Text } from '@mantine/core'

import type { PdfUploadProps } from './PdfUpload.types'

import classes from './PdfUpload.module.css'

export function PdfUpload({ opened, onClose, upload }: PdfUploadProps) {
  const { state, selectFile, startUpload, cancelUpload } = upload
  const { status, file, progress, error } = state

  const active = status === 'requesting' || status === 'uploading'
  const uploaded = status === 'uploaded'
  const retry = status === 'failed' || status === 'cancelled'

  const statusText = {
    idle: 'Choose one PDF to upload.',
    selected: 'Ready to upload.',
    requesting: 'Requesting upload authorization…',
    uploading: progress === 100
      ? '100% transferred. Waiting for storage confirmation…'
      : progress === null
        ? 'Uploading… Progress is not available yet.'
        : `Uploading… ${progress}% transferred.`,
    uploaded: 'Uploaded; not ready for questions.',
    failed: 'Upload failed. Try again or choose another PDF.',
    cancelled: 'Upload cancelled. You can retry or choose another PDF.',
  }[status]

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Add a PDF"
      centered
      size="sm"
      padding="lg"
      shadow="0 2px 8px rgba(0, 0, 0, 0.1)"
      transitionProps={{
        transition: 'fade',
        duration: 150,
      }}
      closeButtonProps={{
        'aria-label': 'Close PDF upload',
      }}
    >
      <Stack gap="lg">
        <Text size="sm" c="gray.7">
          Upload one PDF. Validation and processing are not available yet.
        </Text>

        <FileInput
          label="PDF file"
          placeholder="Choose a PDF"
          description="One nonempty .pdf file, up to 10 MiB."
          accept=".pdf,application/pdf"
          value={file}
          valueComponent={({ value }) => (
            <span>{Array.isArray(value) ? value[0]?.name : value?.name}</span>
          )}
          onChange={(candidate) => {
            if (candidate) {
              selectFile(candidate)
            }
          }}
          disabled={active || uploaded}
          error={status === 'idle' ? error : null}
          errorProps={{
            role: 'alert',
          }}
          classNames={{
            input: classes.fileInput,
          }}
        />

        <Stack gap="sm">
          <Text size="sm" role="status" className={classes.status}>
            {statusText}
          </Text>

          {active && (
            <Progress.Root
              role="progressbar"
              aria-label="PDF upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress ?? undefined}
              aria-valuetext={statusText}
              size="sm"
            >
              <Progress.Section value={progress ?? 100} withAria={false} striped={progress === null} />
            </Progress.Root>
          )}

          {status === 'failed' && (
            <Text size="sm" c="red.8" role="alert">{error}</Text>
          )}

          {status === 'cancelled' && (
            <Text size="sm" c="gray.7">
              Cancellation does not guarantee deletion of a file storage may already have accepted.
            </Text>
          )}

          {uploaded && (
            <Text size="sm" c="gray.7">
              This upload is kept in this workspace until refresh. It has not been validated or processed.
            </Text>
          )}
        </Stack>

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>Close</Button>

          {active ? (
            <Button variant="default" onClick={cancelUpload}>Cancel upload</Button>
          ) : !uploaded && (
            <Button disabled={!file} onClick={() => void startUpload()}>
              {retry ? 'Retry upload' : 'Upload PDF'}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}
