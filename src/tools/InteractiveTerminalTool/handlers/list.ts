import type { PtySessionManager } from '../../../utils/pty/PtySessionManager.js'

export function handleList(manager: PtySessionManager) {
  const sessions = manager.list()

  return {
    sessions,
    count: sessions.length,
  }
}
