import type { UUID } from 'crypto'
import { readdir } from 'fs/promises'
import { dirname, join } from 'path'
import { listSessionsImpl } from '../utils/listSessionsImpl.js'
import {
  loadTranscriptFromFile,
  saveCustomTitle,
} from '../utils/sessionStorage.js'
import { resolveSessionFilePath } from '../utils/sessionStoragePortable.js'

export const AGENT_ID = /^[\w-]{1,100}$/

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type HistoryEntry = {
  id: string
  title: string
  cwd?: string
  lastModified: number
}

/** Sessions across all projects, newest first. */
export async function listHistory(
  offset: number,
  limit: number,
): Promise<HistoryEntry[]> {
  const sessions = await listSessionsImpl({ offset, limit })
  return sessions.map(s => ({
    id: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || s.sessionId,
    cwd: s.cwd,
    lastModified: s.lastModified,
  }))
}

type ContentBlock = { type?: string; text?: string }

function isVisible(message: Record<string, unknown>): boolean {
  if (message.type === 'assistant') return true
  if (message.type !== 'user' || message.isMeta || message.isCompactSummary) {
    return false
  }
  const inner = message.message as { content?: unknown } | undefined
  const content = inner?.content
  if (typeof content === 'string') return !content.startsWith('<')
  if (!Array.isArray(content)) return false
  // Tool results render inside the assistant's tool card.
  return (content as ContentBlock[]).some(
    b =>
      b.type === 'tool_result' ||
      b.type === 'image' ||
      (b.type === 'text' && !b.text?.startsWith('<')),
  )
}

/**
 * The visible main-chain messages of a session, shaped like stream-json so
 * the page folds them with the same reducer it uses for live output. Pages
 * backwards: `before` is an index into the full list.
 */
export async function readTranscript(
  id: string,
  before: number | undefined,
  limit: number,
): Promise<
  | {
      messages: Record<string, unknown>[]
      start: number
      total: number
      cwd?: string
      title?: string
    }
  | undefined
> {
  const found = await resolveSessionFilePath(id)
  if (!found) return undefined
  const log = await loadTranscriptFromFile(found.filePath)
  const visible = toStreamJson(log.messages, false)
  const end = Math.min(before ?? visible.length, visible.length)
  const start = Math.max(0, end - limit)
  const first = log.messages[0] as { cwd?: string } | undefined
  return {
    messages: visible.slice(start, end),
    start,
    total: visible.length,
    cwd: first?.cwd ?? found.projectPath,
    title: log.customTitle ?? log.summary,
  }
}

function toStreamJson(
  messages: unknown[],
  sidechain: boolean,
): Record<string, unknown>[] {
  return (messages as Record<string, unknown>[])
    .filter(m => (sidechain || !m.isSidechain) && isVisible(m))
    .map(m => ({
      type: m.type,
      uuid: m.uuid,
      parent_tool_use_id: null,
      message: m.message,
      // stream-json's flag for user messages echoed back from the transcript.
      ...(m.type === 'user' && { isReplay: true }),
    }))
}

async function findFile(dir: string, name: string, depth = 3): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name)
  if (depth === 0) return undefined
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const found = await findFile(join(dir, e.name), name, depth - 1)
    if (found) return found
  }
  return undefined
}

/**
 * A subagent's transcript (`<session>/subagents/**\/agent-<id>.jsonl`, next
 * to the session's own file), shaped like the main transcript.
 */
export async function readAgentTranscript(
  sessionId: string,
  agentId: string,
): Promise<{ messages: Record<string, unknown>[] } | undefined> {
  const found = await resolveSessionFilePath(sessionId)
  if (!found) return undefined
  const file = await findFile(
    join(dirname(found.filePath), sessionId, 'subagents'),
    `agent-${agentId}.jsonl`,
  )
  if (!file) return undefined
  const log = await loadTranscriptFromFile(file)
  return { messages: toStreamJson(log.messages, true) }
}

export async function renameSession(id: string, title: string): Promise<boolean> {
  const found = await resolveSessionFilePath(id)
  if (!found) return false
  await saveCustomTitle(id as UUID, title, found.filePath)
  return true
}
