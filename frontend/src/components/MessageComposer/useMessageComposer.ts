import { useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { MessageComposerProps } from './MessageComposer.types'

export function useMessageComposer(onSend: MessageComposerProps['onSend']) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return

    onSend(text)
    setDraft('')
    inputRef.current?.focus()
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  return { draft, setDraft, inputRef, sendMessage, handleComposerKeyDown }
}
