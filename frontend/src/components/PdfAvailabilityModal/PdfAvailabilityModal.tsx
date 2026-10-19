import { Button, Group, Modal, Text } from '@mantine/core'
import type { PdfAvailabilityModalProps } from './PdfAvailabilityModal.types'

export function PdfAvailabilityModal({ opened, onClose }: PdfAvailabilityModalProps) {
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
      <Text size="sm">
        PDF upload is not available yet. You can write messages in this workspace,
        but answers will be available after PDF support is added.
      </Text>
      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={onClose}>Close</Button>
      </Group>
    </Modal>
  )
}
