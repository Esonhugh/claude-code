import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'

export function handleList(manager: PtySessionManager) {
  const panes = manager.list().map(({ sessionId, ...session }) => ({
    ...session,
    target: sessionId,
  }))

  return {
    panes,
    count: panes.length,
  }
}
