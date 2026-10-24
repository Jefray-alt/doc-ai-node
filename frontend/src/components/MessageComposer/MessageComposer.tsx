import { Button, Group, Text, Textarea } from '@mantine/core'
import type { MessageComposerProps } from './MessageComposer.types'
import { useMessageComposer } from './useMessageComposer'
import classes from './MessageComposer.module.css'

export function MessageComposer({ onSend }: MessageComposerProps) {
  const { draft, setDraft, inputRef, sendMessage, handleComposerKeyDown } = useMessageComposer(onSend)

  return (
    <form onSubmit={sendMessage} className={classes.composer} aria-label="Message composer">
      <Text size="sm" c="gray.7" mb="md" id="workspace-availability">
        You can write messages here. PDF answers are not available yet.
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
      />
      <Group justify="space-between" gap="sm" mt="sm" wrap="nowrap">
        <Text size="xs" c="gray.7" id="composer-shortcuts">
          Enter to send · Shift + Enter for a new line
        </Text>
        <Button type="submit" disabled={!draft.trim()} aria-label="Send message">
          Send
        </Button>
      </Group>
      <Text size="xs" c="gray.7" mt="md">
        Messages are cleared when you refresh or close this tab.
      </Text>
    </form>
  )
}
