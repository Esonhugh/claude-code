import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useMailbox } from '../context/mailbox.js'

type Props = {
  enabled?: boolean
  isLoading: boolean
  onSubmitMessage: (content: string) => boolean
}

export function useMailboxBridge({
  enabled = true,
  isLoading,
  onSubmitMessage,
}: Props): void {
  const mailbox = useMailbox()

  const subscribe = useMemo(() => mailbox.subscribe.bind(mailbox), [mailbox])
  const getSnapshot = useCallback(() => mailbox.revision, [mailbox])
  const revision = useSyncExternalStore(subscribe, getSnapshot)

  useEffect(() => {
    if (!enabled || isLoading) return
    const msg = mailbox.poll()
    if (msg) onSubmitMessage(msg.content)
  }, [enabled, isLoading, revision, mailbox, onSubmitMessage])
}
