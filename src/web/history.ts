import { randomUUID, type UUID } from 'crypto'
import { readdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { selectableUserMessagesFilter } from '../components/MessageSelector.js'
import type { Message } from '../types/message.js'
import { listSessionsImpl } from '../utils/listSessionsImpl.js'
import type { TranscriptMessage } from '../types/logs.js'
import {
  buildConversationChain,
  findLatestMessage,
  loadTranscriptFile,
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

const LOCAL_COMMAND = /^<(command-name|command-message|local-command-stdout|local-command-stderr)>/

function isVisible(message: Record<string, unknown>): boolean {
  if (message.type === 'assistant') return true
  // The compaction divider and the summary under it.
  if (message.type === 'system') {
    return message.subtype === 'compact_boundary' || (message.subtype === 'local_command' && typeof message.content === 'string')
  }
  if (message.type === 'user' && message.isCompactSummary) return true
  if (message.type === 'attachment') {
    const attachment = message.attachment as { type?: string; commandMode?: string } | undefined
    // A message the user sent mid-turn, fed to the model between tool calls.
    if (attachment?.type === 'queued_command') return (attachment.commandMode ?? 'prompt') === 'prompt'
    return attachment?.type === 'goal_status'
  }
  // A channel message is meta to the model; the person sees it, as in the TUI.
  if (message.type === 'user' && (message.origin as { kind?: unknown } | undefined)?.kind === 'channel') return true
  if (message.type !== 'user' || message.isMeta) {
    return false
  }
  const inner = message.message as { content?: unknown } | undefined
  const content = inner?.content
  // Slash commands and their local output show like the TUI's `> /model` and `⎿` lines.
  // A task ending the coordinator read: the page notes it where it happened.
  if (typeof content === 'string') return !content.startsWith('<') || LOCAL_COMMAND.test(content) || content.startsWith('<task-notification>')
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
      /** With the newest page: the prompts a resumed session's /rewind lists. */
      rewindPoints?: string[]
    }
  | undefined
> {
  const found = await resolveSessionFilePath(id)
  if (!found) return undefined
  const log = await loadTranscriptFile(found.filePath, { keepPreCompact: true })
  const leaf = findLatestMessage(log.messages.values(), m => log.leafUuids.has(m.uuid))
  if (!leaf) return undefined
  const chain = wholeChain(log.messages, leaf)
  const visible = toStreamJson(chain, false)
  const end = Math.min(before ?? visible.length, visible.length)
  const start = Math.max(0, end - limit)
  const first = chain[0] as { cwd?: string } | undefined
  return {
    messages: visible.slice(start, end),
    start,
    total: visible.length,
    cwd: first?.cwd ?? found.projectPath,
    title: log.customTitles.get(leaf.sessionId as UUID) ?? log.summaries.get(leaf.uuid),
    ...(before === undefined && { rewindPoints: await resumedRewindPoints(found.filePath, leaf.uuid) }),
  }
}

/** What --resume loads (no pre-compact messages), filtered as /rewind lists it. */
async function resumedRewindPoints(filePath: string, leafUuid: UUID): Promise<string[]> {
  const log = await loadTranscriptFile(filePath)
  const leaf = log.messages.get(leafUuid)
  if (!leaf) return []
  return (buildConversationChain(log.messages, leaf) as Message[]).filter(selectableUserMessagesFilter).map(m => m.uuid)
}

/**
 * The chain to `leaf` across compactions, as the live view showed it: what was
 * said before each boundary (reached by its `logicalParentUuid`), the boundary
 * and its summary, then what followed. A compaction that kept recent messages
 * leaves them where they were said; what followed it hangs off the kept tail on
 * disk and is moved under the summary. Paging indexes into this list stay put
 * when a running session compacts.
 */
function wholeChain(messages: Map<UUID, TranscriptMessage>, leaf: TranscriptMessage): TranscriptMessage[] {
  type Boundary = TranscriptMessage & {
    logicalParentUuid?: UUID
    compactMetadata?: { preservedSegment?: { anchorUuid: UUID; tailUuid: UUID } }
  }
  const linked = new Map(messages)
  let boundary: Boundary | undefined
  for (const m of messages.values()) {
    const seg = boundary?.compactMetadata?.preservedSegment
    if (seg && m.parentUuid === seg.tailUuid && messages.has(seg.anchorUuid)) linked.set(m.uuid, { ...m, parentUuid: seg.anchorUuid })
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      boundary = m as Boundary
      if (boundary.logicalParentUuid && messages.has(boundary.logicalParentUuid)) {
        linked.set(m.uuid, { ...m, parentUuid: boundary.logicalParentUuid })
      }
    }
  }
  return buildConversationChain(linked, linked.get(leaf.uuid) ?? leaf)
}

function toStreamJson(
  messages: unknown[],
  sidechain: boolean,
): Record<string, unknown>[] {
  // When the entry before each message was written: a thinking block ends about that long after it.
  const before = new Map<unknown, number>()
  let last: number | undefined
  for (const m of messages as Record<string, unknown>[]) {
    const at = typeof m.timestamp === 'string' ? Date.parse(m.timestamp) : NaN
    if (last !== undefined) before.set(m, last)
    if (Number.isFinite(at)) last = at
  }
  return (messages as Record<string, unknown>[])
    .filter(m => (sidechain || !m.isSidechain) && isVisible(m))
    .map(m => {
      // Shaped like the live stream's `system/compact_boundary` and `goal_state_changed`.
      if (m.type === 'system' && m.subtype === 'local_command') {
        // `/name` and its `<local-command-stdout>`, as the live stream replays them.
        return { type: 'user', uuid: m.uuid, timestamp: m.timestamp, parent_tool_use_id: null, isReplay: true, message: { role: 'user', content: m.content } }
      }
      if (m.type === 'system') {
        const meta = (m.compactMetadata ?? {}) as { trigger?: unknown; preTokens?: unknown; postTokens?: unknown }
        return {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: m.uuid,
          timestamp: m.timestamp,
          compact_metadata: { trigger: meta.trigger, pre_tokens: meta.preTokens, post_tokens: meta.postTokens },
        }
      }
      if (m.type === 'attachment') {
        const attachment = m.attachment as { type?: string; prompt?: unknown; source_uuid?: string }
        if (attachment.type === 'queued_command') {
          // As the live stream replays it: the uuid the page sent it with.
          return { type: 'user', uuid: attachment.source_uuid ?? m.uuid, timestamp: m.timestamp, parent_tool_use_id: null, isReplay: true, message: { role: 'user', content: attachment.prompt } }
        }
        return { type: 'system', subtype: 'goal_state_changed', uuid: m.uuid, goal: m.attachment }
      }
      return {
        type: m.type,
        uuid: m.uuid,
        timestamp: m.timestamp,
        parent_tool_use_id: null,
        message: m.message,
        // stream-json's flag for user messages echoed back from the transcript.
        ...(m.type === 'user' && { isReplay: true }),
        ...(m.isCompactSummary === true && { isCompactSummary: true }),
        // A file edit's patch for the diff card; not the whole file it also holds.
        ...(m.type === 'user' && editPatch(m.toolUseResult)),
        // The live stream marks API error messages with `error`; keep that for the page.
        ...(m.type === 'assistant' && m.isApiErrorMessage === true && { isApiErrorMessage: true }),
        ...(m.type === 'assistant' && thinkingMs(m, before.get(m))),
      }
    })
}

/** How long a thinking entry took, from the entry written before it; the transcript keeps no duration. */
function thinkingMs(m: Record<string, unknown>, prev: number | undefined): { thinking_ms?: number } {
  const content = (m.message as { content?: unknown } | undefined)?.content
  if (prev === undefined || !Array.isArray(content) || !content.some(c => (c as { type?: unknown })?.type === 'thinking')) return {}
  const ms = Date.parse(String(m.timestamp)) - prev
  return Number.isFinite(ms) && ms >= 0 ? { thinking_ms: ms } : {}
}

function editPatch(result: unknown): { tool_use_result?: Record<string, unknown> } {
  if (typeof result !== 'object' || result === null) return {}
  const { type, structuredPatch } = result as { type?: unknown; structuredPatch?: unknown }
  if (!Array.isArray(structuredPatch)) return {}
  return { tool_use_result: { type, structuredPatch } }
}

/** The first assistant text of a session, cut to a card's length. */
/** Markdown as one line of plain text: no code fences, table rules, headings, emphasis or link targets. */
export function snippetText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function readSnippet(id: string): Promise<string | undefined> {
  const found = await resolveSessionFilePath(id)
  if (!found) return undefined
  const log = await loadTranscriptFromFile(found.filePath)
  for (const m of log.messages as unknown as Record<string, unknown>[]) {
    if (m.type !== 'assistant' || m.isSidechain || m.isApiErrorMessage) continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    const text = snippetText(
      (content as ContentBlock[])
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text)
        .join('\n'),
    )
    if (text) return text.slice(0, 240)
  }
  return ''
}

async function findFiles(
  dir: string,
  match: (name: string) => boolean,
  depth = 3,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const found = entries.filter(e => e.isFile() && match(e.name)).map(e => join(dir, e.name))
  if (depth === 0) return found
  for (const e of entries) {
    if (e.isDirectory()) found.push(...(await findFiles(join(dir, e.name), match, depth - 1)))
  }
  return found
}

async function subagentsDir(sessionId: string): Promise<string | undefined> {
  const found = await resolveSessionFilePath(sessionId)
  return found && join(dirname(found.filePath), sessionId, 'subagents')
}

/**
 * A subagent's transcript (`<session>/subagents/**\/agent-<id>.jsonl`, next
 * to the session's own file), shaped like the main transcript.
 */
export async function readAgentTranscript(
  sessionId: string,
  agentId: string,
): Promise<{ messages: Record<string, unknown>[] } | undefined> {
  const dir = await subagentsDir(sessionId)
  if (!dir) return undefined
  const [file] = await findFiles(dir, name => name === `agent-${agentId}.jsonl`)
  if (!file) return undefined
  const log = await loadTranscriptFromFile(file)
  return { messages: toStreamJson(log.messages, true) }
}

/**
 * Which subagent issued each of these Agent tool calls: the agent whose
 * transcript holds the `tool_use` block, by tool use id.
 */
export async function findAgentIssuers(
  sessionId: string,
  toolUseIds: string[],
): Promise<Record<string, string>> {
  const issuers: Record<string, string> = {}
  const dir = await subagentsDir(sessionId)
  if (!dir || !toolUseIds.length) return issuers
  const files = await findFiles(dir, name => /^agent-[\w-]+\.jsonl$/.test(name))
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const id of toolUseIds) {
      if (!issuers[id] && text.includes(`"type":"tool_use","id":"${id}"`)) {
        issuers[id] = /agent-([\w-]+)\.jsonl$/.exec(file)![1]!
      }
    }
  }
  return issuers
}

/**
 * A new session holding the conversation up to and including the assistant
 * message `messageId` (an API `msg_` id), like `/branch`: same folder, new
 * session id, each entry marked with where it came from. Resume it to continue.
 */
export async function forkSession(id: string, messageId: string): Promise<string | undefined> {
  const found = await resolveSessionFilePath(id)
  if (!found) return undefined
  const log = await loadTranscriptFile(found.filePath)
  const leaf = findLatestMessage(log.messages.values(), m => log.leafUuids.has(m.uuid))
  if (!leaf) return undefined
  const chain = buildConversationChain(log.messages, leaf)
  const end = chain.findLastIndex(m => m.type === 'assistant' && (m.message as { id?: unknown } | undefined)?.id === messageId)
  if (end === -1) return undefined
  const forkId = randomUUID()
  const lines = chain
    .slice(0, end + 1)
    .filter(m => !m.isSidechain)
    .map(m => JSON.stringify({ ...m, sessionId: forkId, forkedFrom: { sessionId: id, messageUuid: m.uuid } }))
  await writeFile(join(dirname(found.filePath), `${forkId}.jsonl`), lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return forkId
}

export async function renameSession(id: string, title: string): Promise<boolean> {
  const found = await resolveSessionFilePath(id)
  if (!found) return false
  await saveCustomTitle(id as UUID, title, found.filePath)
  return true
}
