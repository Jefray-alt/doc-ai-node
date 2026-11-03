import { Button, Group, Text, Textarea } from '@mantine/core'
import type { FormEvent } from 'react'
import type { MessageComposerProps } from './MessageComposer.types'
import { useMessageComposer } from './useMessageComposer'
import classes from './MessageComposer.module.css'

export function MessageComposer({ onSend, disabled = false }: MessageComposerProps) {
  const { draft, setDraft, inputRef, sendMessage, handleComposerKeyDown } = useMessageComposer(onSend)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (disabled) {
      event.preventDefault()
      return
    }
    sendMessage(event)
  }

  return (
    <form onSubmit={handleSubmit} className={classes.composer} aria-label="Message composer">
      <Text size="sm" c="gray.7" mb="md" id="workspace-availability">
        {disabled ? 'Document preparation is not available yet.' : 'PDF upload and answers are not available yet.'}
      </Text>
      <Textarea
        ref={inputRef}
        label="Message"
        placeholder="Write a message…"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={handleComposerKeyDown}
        autosize
        minRows={2}
        maxRows={6}
        size="md"
        aria-describedby="workspace-availability composer-shortcuts"
        disabled={disabled}
      />
      <Group justify="space-between" gap="sm" mt="sm" wrap="nowrap">
        <Text size="xs" c="gray.7" id="composer-shortcuts">
          Enter to send · Shift + Enter for a new line
        </Text>
        <Button type="submit" disabled={disabled || !draft.trim()} aria-label="Send message">
          Send
        </Button>
      </Group>
      <Text size="xs" c="gray.7" mt="md">
        Messages are cleared when you refresh or close this tab.
      </Text>
    </form>
  )
}
