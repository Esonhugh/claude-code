import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { createReplExecutor, type ReplExecutor } from './executor/host.js'

/** One persistent JavaScript context per conversation thread: the main thread or a subagent. */
export type ReplSession = {
  executor: ReplExecutor
  /** The session id the context was made in; a new one (/clear, a resume, a fork) starts over. */
  epoch: string
  /** False until the first script ran, so the first call knows it is in a new context. */
  used: boolean
}

export const MAIN_REPL_SESSION = 'main'

const sessions = new Map<string, ReplSession>()
let unregisterCleanup: (() => void) | undefined

/** The context for `key`, made on first use or when the session id moved on. */
export function getReplSession(key: string): ReplSession {
  const epoch = getSessionId()
  const existing = sessions.get(key)
  if (existing && existing.epoch === epoch) return existing
  existing?.executor.release()
  const session: ReplSession = { executor: createReplExecutor(), epoch, used: false }
  sessions.set(key, session)
  unregisterCleanup ??= registerCleanup(async () => releaseAllReplSessions())
  return session
}

/** Ends the context for `key` (a finished subagent); the next script there starts fresh. */
export function releaseReplSession(key: string): void {
  const session = sessions.get(key)
  if (!session) return
  sessions.delete(key)
  session.executor.release()
}

export function releaseAllReplSessions(): void {
  for (const key of [...sessions.keys()]) releaseReplSession(key)
}

export function hasReplSession(key: string): boolean {
  return sessions.has(key)
}
