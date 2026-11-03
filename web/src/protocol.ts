// Folds the stream-json messages of one `claude -p` session into the view
// model the chat renders. Unknown message types are ignored, so newer engine
// messages never break the page.

import { isFinished, reduceTasks, type Tasks } from './agents'
import type { SlashCommand } from './commands'
import type { MessageKey } from './i18n'

export type Block =
  | { kind: 'text'; text: string }
  /** `startedAt` / `ms`: how long the model thought, measured while it streamed. */
  | { kind: 'thinking'; text: string; startedAt?: number; ms?: number }
  | {
      kind: 'tool'
      id: string
      name: string
      input: string
      result?: string
      isError?: boolean
      /** The file edit part of `tool_use_result` (Edit, Write): its structured patch. */
      meta?: { type?: string; structuredPatch?: unknown[] }
    }

export type Item =
  | { kind: 'user'; id: string; text: string; images?: string[] }
  /** `compact_boundary`: the conversation was summarized here. */
  | {
      kind: 'compact'
      id: string
      trigger: string
      preTokens?: number
      postTokens?: number
      at?: number
      summary?: string
    }
  /** A one-line `/recap` (the TUI's `※` away summary); `away` in minutes. */
  | { kind: 'recap'; id: string; text: string; away?: number }
  /** A centered muted line the page adds itself, e.g. after a rewind. */
  | { kind: 'note'; id: string; text: string; key?: MessageKey }
  /** A goal ended (met, cleared or failed). */
  | { kind: 'goal'; id: string; status: string; iterations?: number; durationMs?: number }
  | {
      kind: 'assistant'
      id: string
      model?: string
      streamed: boolean
      blocks: Block[]
    }
  | { kind: 'error'; id: string; text: string }
  /** Output of a local slash command (`/model`, `/usage`), shown as a muted system line. */
  | { kind: 'local'; id: string; text: string; isError?: boolean }
  /** A message a teammate sent the lead (`<teammate-message>`). */
  | { kind: 'teammate'; id: string; from: string; color?: string; summary?: string; text: string }
  /** A message a channel (an MCP server such as Telegram) pushed in: `<channel source="…" user="…">`. */
  | { kind: 'channel'; id: string; source: string; user?: string; text: string }

export type Approval = {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  /** Rules the engine offers for "always allow" (PermissionUpdate[]). */
  suggestions: unknown[]
  toolUseId?: string
  /** The subagent asking (a project task), when it is not the session itself. */
  agentId?: string
}

/** The user's answer to an approval, shown where the request was. */
export type Decision = { toolName: string; choice: ApprovalChoice; rules?: string }

/** `/goal` as `system/goal_state_changed` reports it. `checks`: reasons the condition was not met yet. */
export type Goal = {
  condition: string
  status: string
  iterations: number
  setAt?: number
  checks: string[]
}

/** `get_context_usage`, grouped like the prototype's meter. */
export type ContextUsage = {
  total: number
  max: number
  percent: number
  system: number
  tools: number
  messages: number
  autoCompact: boolean
  threshold?: number
}

export type RateLimit = { type?: string; utilization?: number; resetsAt?: number }

export type ModelOption = {
  value: string
  displayName: string
  resolvedModel?: string
  description?: string
  effortLevels?: string[]
}

/** The SDK `ModelInfo` list (initialize `models`, `/api/models`) as the picker's options. */
export function parseModels(raw: unknown): ModelOption[] {
  return (Array.isArray(raw)
    ? raw.filter(isObj).map(m => ({
        value: str(m.value) ?? '',
        displayName: str(m.displayName) ?? str(m.value) ?? '',
        ...withoutUndefined({
          resolvedModel: str(m.resolvedModel),
          description: str(m.description),
          effortLevels:
            m.supportsEffort === true && Array.isArray(m.supportedEffortLevels)
              ? m.supportedEffortLevels.filter(l => typeof l === 'string')
              : undefined,
        }),
      }))
    : []
  ).filter(m => m.value)
}

export type Hook = { event: string; matcher: string; command: string; timeout?: number }

/** What the session reports about itself and its machine (init, initialize, get_settings). */
export type SessionEnv = {
  version?: string
  mcpServers?: { name: string; status: string }[]
  skills?: string[]
  plugins?: { name: string; path: string }[]
  apiKeySource?: string
  account?: { email?: string; subscriptionType?: string; apiKeySource?: string; apiProvider?: string }
  uiName?: string
  hooks?: Hook[]
  /** Settings allow plan mode (`planModeAvailable`). */
  planMode?: boolean
}

export type ChatState = {
  items: Item[]
  busy: boolean
  model?: string
  cwd?: string
  approvals: Approval[]
  /** Message id of the assistant message currently streaming. */
  streamingId?: string
  permissionMode?: string
  models: ModelOption[]
  contextPercent?: number
  costUsd?: number
  /** Effort level the session applies (get_settings `applied.effort`). */
  effort?: string
  env: SessionEnv
  /** Error from the last control request the user triggered (mode, model). */
  notice?: string
  /** Subagents, workflows and other background tasks, by task id. */
  tasks: Tasks
  /** Slash commands the session can run, for the `/` palette. */
  commands: SlashCommand[]
  /** Commands bound to the local terminal; hidden from the palette. */
  terminalCommands: string[]
  /** Answered approvals by tool use id (request id when the request had none). */
  decisions: Record<string, Decision>
  goal?: Goal
  context?: ContextUsage
  /** Latest `rate_limit_event` per window type. */
  rateLimits: Record<string, RateLimit>
  /** Tasks that ended, in order, each after the item that was last when it did (a project's notice lines). */
  taskNotes: TaskNote[]
  /** The ending lines already counted for `taskNotes` (see addNote). */
  noteKeys: string[]
  /** A `/recap` is on its way; its output becomes a `※` line. */
  recapPending?: { away?: number }
  /** When the first message of this chat was sent (ms). */
  startedAt?: number
  /** Sent while a turn ran; each moves into `items` once the model reads it. */
  queued: Extract<Item, { kind: 'user' }>[]
}

export const initialState: ChatState = {
  items: [],
  busy: false,
  approvals: [],
  models: [],
  env: {},
  tasks: {},
  commands: [],
  terminalCommands: [],
  decisions: {},
  rateLimits: {},
  taskNotes: [],
  noteKeys: [],
  queued: [],
}

type Json = Record<string, unknown>

function withoutUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      isObj(part) && part.type === 'text' ? (str(part.text) ?? '') : '',
    )
    .filter(Boolean)
    .join('\n')
}

function blockFromContent(part: Json): Block | undefined {
  switch (part.type) {
    case 'text':
      return { kind: 'text', text: str(part.text) ?? '' }
    case 'thinking':
      return { kind: 'thinking', text: str(part.thinking) ?? '' }
    case 'tool_use':
      return {
        kind: 'tool',
        id: str(part.id) ?? '',
        name: str(part.name) ?? '',
        input: part.input === undefined ? '' : JSON.stringify(part.input),
      }
    default:
      return undefined
  }
}

function updateLastAssistant(
  state: ChatState,
  id: string,
  fn: (item: Extract<Item, { kind: 'assistant' }>) => Item,
): ChatState {
  const index = state.items.findIndex(
    item => item.kind === 'assistant' && item.id === id,
  )
  if (index === -1) return state
  const items = state.items.slice()
  items[index] = fn(items[index] as Extract<Item, { kind: 'assistant' }>)
  return { ...state, items }
}

function mapTool(
  state: ChatState,
  toolId: string,
  fn: (block: Extract<Block, { kind: 'tool' }>) => Block,
): ChatState {
  let changed = false
  const items = state.items.map(item => {
    if (item.kind !== 'assistant') return item
    if (!item.blocks.some(b => b.kind === 'tool' && b.id === toolId)) {
      return item
    }
    changed = true
    return {
      ...item,
      blocks: item.blocks.map(b =>
        b.kind === 'tool' && b.id === toolId ? fn(b) : b,
      ),
    }
  })
  return changed ? { ...state, items } : state
}

function reduceStreamEvent(state: ChatState, event: Json): ChatState {
  const { streamingId } = state
  switch (event.type) {
    case 'message_start': {
      const message = isObj(event.message) ? event.message : {}
      const id = str(message.id) ?? `stream-${state.items.length}`
      if (state.items.some(i => i.kind === 'assistant' && i.id === id)) {
        return { ...state, streamingId: id }
      }
      return {
        ...state,
        streamingId: id,
        items: [
          ...state.items,
          {
            kind: 'assistant',
            id,
            model: str(message.model),
            streamed: true,
            blocks: [],
          },
        ],
      }
    }
    case 'content_block_start': {
      const index = typeof event.index === 'number' ? event.index : -1
      const block = isObj(event.content_block)
        ? blockFromContent(event.content_block)
        : undefined
      if (!streamingId || index < 0 || !block) return state
      if (block.kind === 'tool') block.input = ''
      if (block.kind === 'thinking') block.startedAt = Date.now()
      return updateLastAssistant(state, streamingId, item => {
        const blocks = item.blocks.slice()
        blocks[index] = block
        return { ...item, blocks }
      })
    }
    case 'content_block_stop': {
      const index = typeof event.index === 'number' ? event.index : -1
      if (!streamingId || index < 0) return state
      return updateLastAssistant(state, streamingId, item => {
        const block = item.blocks[index]
        if (block?.kind !== 'thinking' || block.startedAt === undefined) return item
        const blocks = item.blocks.slice()
        blocks[index] = { ...block, ms: Date.now() - block.startedAt }
        return { ...item, blocks }
      })
    }
    case 'content_block_delta': {
      const index = typeof event.index === 'number' ? event.index : -1
      const delta = isObj(event.delta) ? event.delta : {}
      if (!streamingId || index < 0) return state
      return updateLastAssistant(state, streamingId, item => {
        const block = item.blocks[index]
        if (!block) return item
        let next: Block = block
        if (delta.type === 'text_delta' && block.kind === 'text') {
          next = { ...block, text: block.text + (str(delta.text) ?? '') }
        } else if (
          delta.type === 'thinking_delta' &&
          block.kind === 'thinking'
        ) {
          next = { ...block, text: block.text + (str(delta.thinking) ?? '') }
        } else if (
          delta.type === 'input_json_delta' &&
          block.kind === 'tool'
        ) {
          next = {
            ...block,
            input: block.input + (str(delta.partial_json) ?? ''),
          }
        }
        if (next === block) return item
        const blocks = item.blocks.slice()
        blocks[index] = next
        return { ...item, blocks }
      })
    }
    default:
      return state
  }
}

export function addUserMessage(
  state: ChatState,
  text: string,
  images?: string[],
  uuid?: string,
): ChatState {
  const id = uuid ?? `user-${state.items.length}`
  const items: Item[] = [...state.items, { kind: 'user', id, text, ...(images?.length && { images }) }]
  // `-p` keeps the goal a slash command sets or clears out of the stream (the
  // judge's later checks do arrive), so follow it from the command itself.
  const arg = /^\/goal\s+(\S[\s\S]*)$/.exec(text.trim())?.[1]
  let goal = state.goal
  if (arg === 'clear') {
    if (goal) items.push({ kind: 'goal', id: `goal-${id}`, status: 'cleared', iterations: goal.iterations })
    goal = undefined
  } else if (arg) {
    goal = { condition: arg, status: 'active', iterations: 0, setAt: Date.now(), checks: [] }
  }
  return { ...state, busy: true, startedAt: state.startedAt ?? Date.now(), items, goal }
}

/**
 * A message sent while a turn runs. The engine queues it and feeds it to the
 * model between tool calls, or runs it as the next turn; its echo (same uuid)
 * moves it into the chat.
 */
export function queueUserMessage(state: ChatState, text: string, uuid: string, images?: string[]): ChatState {
  return { ...state, queued: [...state.queued, { kind: 'user', id: uuid, text, ...(images?.length && { images }) }] }
}

/** The rules an "always allow" answer adds, as `Bash(npm test:*)`. */
export function approvalRules(approval: Approval): string[] {
  return approval.suggestions
    .flatMap(s => {
      const rule = s as { rules?: { toolName?: string; ruleContent?: string }[] }
      return (rule.rules ?? []).map(r => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : (r.toolName ?? '')))
    })
    .filter(Boolean)
}

/** Drops an answered approval and remembers the answer for its place in the chat. */
export function answerApproval(state: ChatState, approval: Approval, choice: ApprovalChoice): ChatState {
  const rules = choice === 'always' ? approvalRules(approval).join(', ') : ''
  return {
    ...removeApproval(state, approval.requestId),
    decisions: {
      ...state.decisions,
      [approval.toolUseId ?? approval.requestId]: {
        toolName: approval.toolName,
        choice,
        ...(rules && { rules }),
      },
    },
  }
}

/** A `/recap` the page sent itself: no bubble, its answer shows as a `※` line. */
export function startRecap(state: ChatState, away?: number): ChatState {
  return { ...state, busy: true, recapPending: away === undefined ? {} : { away } }
}

/** The text of user content (a string or text blocks). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (isObj(part) && part.type === 'text' ? (str(part.text) ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

const COMPACT_SUMMARY = /^This session is being continued from a previous conversation/

/**
 * Adds a local command's output, or a `※` recap line when it answers a
 * `/recap` (one the page sent, or one the user typed whose bubble it replaces).
 */
function addLocal(state: ChatState, item: Extract<Item, { kind: 'local' }>): ChatState {
  const last = state.items.at(-1)
  const typed = last?.kind === 'user' && last.text.trim() === '/recap'
  if (!item.isError && (state.recapPending || typed)) {
    const items = typed ? state.items.slice(0, -1) : state.items
    return {
      ...state,
      recapPending: undefined,
      items: [...items, { kind: 'recap', id: item.id, text: item.text, ...(state.recapPending?.away !== undefined && { away: state.recapPending.away }) }],
    }
  }
  // "Compacted" after a compaction: the mark already says so.
  if (!item.isError && last?.kind === 'compact') return { ...state, recapPending: undefined }
  return { ...state, recapPending: undefined, items: [...state.items, item] }
}

function reduceGoal(state: ChatState, raw: Json): ChatState {
  const goal = isObj(raw.goal) ? raw.goal : {}
  const status = str(goal.status) ?? ''
  const iterations = typeof goal.iterations === 'number' ? goal.iterations : 0
  if (status === 'active') {
    const prev = state.goal?.status === 'active' && state.goal.condition === str(goal.condition) ? state.goal : undefined
    const reason = str(goal.reason)
    const checks = prev?.checks ?? []
    return {
      ...state,
      goal: {
        condition: str(goal.condition) ?? '',
        status,
        iterations,
        ...(typeof goal.setAt === 'number' && { setAt: goal.setAt }),
        checks: reason && goal.met !== true && checks.at(-1) !== reason ? [...checks, reason] : checks,
      },
    }
  }
  const ended: Item = {
    kind: 'goal',
    id: str(raw.uuid) ?? `goal-${state.items.length}`,
    status,
    ...(typeof goal.iterations === 'number' && { iterations }),
    ...(typeof goal.durationMs === 'number' && { durationMs: goal.durationMs }),
  }
  return {
    ...state,
    goal: undefined,
    items: state.items.some(i => i.id === ended.id) ? state.items : [...state.items, ended],
  }
}

const SYSTEM_CONTEXT = new Set(['system_prompt', 'memory_files', 'custom_agents'])
const TOOL_CONTEXT = new Set(['system_tools', 'mcp_tools', 'mcp_instructions', 'skills'])

/** The meter groups of a `get_context_usage` answer. */
export function contextUsage(body: Json): ContextUsage | undefined {
  const total = typeof body.totalTokens === 'number' ? body.totalTokens : undefined
  const max = typeof body.maxTokens === 'number' ? body.maxTokens : undefined
  const percent = typeof body.percentage === 'number' ? body.percentage : body.percentUsed
  if (total === undefined || !max || typeof percent !== 'number') return undefined
  let system = 0
  let tools = 0
  let messages = 0
  for (const c of Array.isArray(body.categories) ? body.categories.filter(isObj) : []) {
    const tokens = typeof c.tokens === 'number' && c.isDeferred !== true ? c.tokens : 0
    const id = str(c.id) ?? ''
    if (id === 'messages') messages += tokens
    else if (SYSTEM_CONTEXT.has(id)) system += tokens
    else if (TOOL_CONTEXT.has(id)) tools += tokens
  }
  return {
    total,
    max,
    percent,
    system,
    tools,
    messages,
    autoCompact: body.isAutoCompactEnabled === true,
    ...(typeof body.autoCompactThreshold === 'number' && { threshold: body.autoCompactThreshold }),
  }
}

/** Removes a rewound prompt and everything after it. */
export function rewindTo(state: ChatState, userId: string, note: string): ChatState {
  const index = state.items.findIndex(i => i.id === userId)
  if (index === -1) return state
  return {
    ...state,
    items: [...state.items.slice(0, index), { kind: 'note', id: `note-${userId}`, text: note }],
  }
}

function imageDataUrl(part: Json): string | undefined {
  const source = isObj(part.source) ? part.source : undefined
  if (source?.type !== 'base64') return undefined
  const type = str(source.media_type)
  const data = str(source.data)
  return type && data ? `data:${type};base64,${data}` : undefined
}

export function removeApproval(
  state: ChatState,
  requestId: string,
): ChatState {
  return {
    ...state,
    approvals: state.approvals.filter(a => a.requestId !== requestId),
  }
}

export function addError(state: ChatState, text: string): ChatState {
  return {
    ...state,
    busy: false,
    items: [
      ...state.items,
      { kind: 'error', id: `error-${state.items.length}`, text },
    ],
  }
}

const SYNTHETIC_MODEL = '<synthetic>'

function tag(text: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]
}

/** `<local-command-stdout>` / `-stderr` of a local slash command, if the text is one. */
export function localCommandOutput(text: string): { text: string; isError?: true } | undefined {
  if (!/^\s*<local-command-std(out|err)>/.test(text)) return undefined
  const stderr = tag(text, 'local-command-stderr')?.trim()
  if (stderr) return { text: stderr, isError: true }
  return { text: tag(text, 'local-command-stdout')?.trim() ?? '' }
}

/** `/name args` of a slash command the user typed, as the transcript records it. */
export function commandInput(text: string): string | undefined {
  const name = tag(text, 'command-name')?.trim()
  if (!name) return undefined
  const args = tag(text, 'command-args')?.trim()
  return `${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`
}

const TEAMMATE_MESSAGE =
  /<teammate-message\s+teammate_id="([^"]+)"(?:\s+color="([^"]+)")?(?:\s+summary="([^"]+)")?>\n?([\s\S]*?)\n?<\/teammate-message>/g

/** The teammate messages a prompt delivers to the lead, if it is one. */
export function teammateMessages(
  text: string,
  id: string,
): Extract<Item, { kind: 'teammate' }>[] {
  return [...text.matchAll(TEAMMATE_MESSAGE)].map((m, i) => ({
    kind: 'teammate',
    id: `${id}-${i}`,
    from: m[1]!,
    ...(m[2] && { color: m[2] }),
    ...(m[3] && { summary: m[3] }),
    text: m[4]!,
  }))
}

// The whole text must be one wrapper, so a prompt that merely mentions the tag stays the person's own.
const CHANNEL_MESSAGE = /^<channel\s+source="([^"]+)"([^>]*)>\n?([\s\S]*?)\n?<\/channel>\s*$/

const unescapeAttr = (value: string) =>
  value.replace(/&(quot|apos|lt|gt|amp);/g, (_, name: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[name]!)

/** A channel message, with the server's leaf name (`plugin:telegram:telegram` → `telegram`) as its source. */
export function channelMessage(text: string, id: string): Extract<Item, { kind: 'channel' }> | undefined {
  const m = CHANNEL_MESSAGE.exec(text)
  if (!m) return undefined
  const source = unescapeAttr(m[1]!)
  const user = /\buser="([^"]+)"/.exec(m[2] ?? '')?.[1]
  return {
    kind: 'channel',
    id,
    source: source.slice(source.lastIndexOf(':') + 1),
    ...(user !== undefined && { user: unescapeAttr(user) }),
    text: m[3] ?? '',
  }
}

/** A task ended; `n` counts its endings (a resumed task can end again), `durationMs` is from the transcript. */
export type TaskNote = { taskId: string; status: string; afterId?: string; n: number; durationMs?: number }

/**
 * Adds the `n`th ending of a task once. The live stream and the transcript
 * (where the coordinator read each ending as a `<task-notification>`) each
 * count a task's endings in order, so a reload that loads the transcript and
 * then gets the task lines replayed shows each ending once, where it happened.
 * `key` names the line itself, so the same line seen twice counts once.
 */
function addNote(state: ChatState, source: 'sys' | 'log', key: string, note: Omit<TaskNote, 'n' | 'afterId'>): Partial<ChatState> {
  const prefix = `${source}\n${note.taskId}\n`
  if (state.noteKeys.includes(prefix + key)) return {}
  const n = state.noteKeys.filter(k => k.startsWith(prefix)).length + 1
  const noteKeys = [...state.noteKeys, prefix + key]
  if (state.taskNotes.some(x => x.taskId === note.taskId && x.n === n)) return { noteKeys }
  return { noteKeys, taskNotes: [...state.taskNotes, { ...note, n, afterId: state.items.at(-1)?.id }] }
}

function noteEnded(state: ChatState, tasks: Tasks, raw: Json): Partial<ChatState> {
  const task = typeof raw.task_id === 'string' ? tasks[raw.task_id] : undefined
  if (raw.subtype !== 'task_notification' || !task || !isFinished(task)) return {}
  return addNote(state, 'sys', str(raw.uuid) ?? task.status, { taskId: task.id, status: task.status })
}

const NOTIFICATION = /^<task-notification>[\s\S]*<\/task-notification>$/

/** A `<task-notification>` the coordinator read, as its transcript holds it. */
function noteFromLog(state: ChatState, text: string, uuid: string): Partial<ChatState> | undefined {
  if (!NOTIFICATION.test(text.trim())) return undefined
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim()
  const taskId = tag('task-id')
  const status = tag('status')
  if (!taskId || !status) return {}
  const duration = Number(tag('duration_ms'))
  return addNote(state, 'log', uuid, { taskId, status, ...(Number.isFinite(duration) && duration > 0 && { durationMs: duration }) })
}

export function reduce(state: ChatState, raw: unknown): ChatState {
  if (!isObj(raw)) return state
  // Subagent traffic (parent_tool_use_id set) belongs to the Agents panel.
  if (raw.parent_tool_use_id) return state
  // What the turn did not take runs as the next turn; its echo comes only after that turn's first reply.
  if (raw.type === 'result' && state.queued.length) {
    const ended = reduce({ ...state, queued: [] }, raw)
    return state.queued.reduce((s, q) => addUserMessage(s, q.text, q.images, q.id), ended)
  }

  switch (raw.type) {
    case 'system':
      if (raw.subtype === 'compact_boundary') {
        const meta = isObj(raw.compact_metadata) ? raw.compact_metadata : {}
        const id = str(raw.uuid) ?? `compact-${state.items.length}`
        if (state.items.some(i => i.id === id)) return state
        const at = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Date.now()
        // The mark stands for a typed `/compact`, as the `※` line does for `/recap`.
        const last = state.items.at(-1)
        const typed = last?.kind === 'user' && /^\/compact(\s|$)/.test(last.text.trim())
        return {
          ...state,
          items: [
            ...(typed ? state.items.slice(0, -1) : state.items),
            {
              kind: 'compact',
              id,
              trigger: str(meta.trigger) ?? 'manual',
              ...(typeof meta.pre_tokens === 'number' && { preTokens: meta.pre_tokens }),
              ...(typeof meta.post_tokens === 'number' && { postTokens: meta.post_tokens }),
              ...(Number.isFinite(at) && { at }),
            },
          ],
        }
      }
      if (raw.subtype === 'goal_state_changed') return reduceGoal(state, raw)
      if (raw.subtype !== 'init') {
        const tasks = reduceTasks(state.tasks, raw)
        return tasks === state.tasks ? state : { ...state, tasks, ...noteEnded(state, tasks, raw) }
      }
      return {
        ...state,
        env: {
          ...state.env,
          ...withoutUndefined({
            version: str(raw.claude_code_version),
            mcpServers: Array.isArray(raw.mcp_servers)
              ? raw.mcp_servers.filter(isObj).map(m => ({ name: str(m.name) ?? '', status: str(m.status) ?? '' }))
              : undefined,
            skills: Array.isArray(raw.skills) ? raw.skills.filter(s => typeof s === 'string') : undefined,
            plugins: Array.isArray(raw.plugins)
              ? raw.plugins
                  .filter(isObj)
                  // Built-in mods (`agents-md@builtin`) are counted under Mods, not installed plugins.
                  .filter(p => !str(p.source)?.endsWith('@builtin'))
                  .map(p => ({ name: str(p.name) ?? '', path: str(p.path) ?? '' }))
              : undefined,
            apiKeySource: str(raw.apiKeySource),
          }),
        },
        model: str(raw.model) ?? state.model,
        cwd: str(raw.cwd) ?? state.cwd,
        permissionMode: str(raw.permissionMode) ?? state.permissionMode,
        terminalCommands: Array.isArray(raw.terminal_slash_commands)
          ? raw.terminal_slash_commands.filter(c => typeof c === 'string')
          : state.terminalCommands,
      }

    case 'stream_event':
      return isObj(raw.event) ? reduceStreamEvent(state, raw.event) : state

    case 'assistant': {
      const message = isObj(raw.message) ? raw.message : {}
      const id = str(message.id) ?? `assistant-${state.items.length}`
      const content = Array.isArray(message.content) ? message.content : []
      const blocks = content
        .filter(isObj)
        .map(blockFromContent)
        .filter((b): b is Block => b !== undefined)
      // `<synthetic>` messages come from the CLI, not the model: API errors
      // and local command output.
      if (message.model === SYNTHETIC_MODEL) {
        const text = blocks
          .map(b => (b.kind === 'text' ? b.text : ''))
          .join('\n')
          .trim()
        if (!text || state.items.some(i => i.id === id)) return state
        if (raw.error !== undefined || raw.isApiErrorMessage === true) {
          return { ...state, items: [...state.items, { kind: 'error', id, text }] }
        }
        return addLocal(state, { kind: 'local', id, text })
      }
      const existing = state.items.find(
        (i): i is Extract<Item, { kind: 'assistant' }> =>
          i.kind === 'assistant' && i.id === id,
      )
      if (existing?.streamed) {
        // The streamed copy already has the text; take the final tool input.
        let next = state
        for (const block of blocks) {
          if (block.kind === 'tool') {
            next = mapTool(next, block.id, b => ({ ...b, input: block.input }))
          }
        }
        return next
      }
      if (existing) {
        return updateLastAssistant(state, id, item => ({
          ...item,
          blocks: [...item.blocks, ...blocks],
        }))
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: 'assistant',
            id,
            model: str(message.model),
            streamed: false,
            blocks,
          },
        ],
      }
    }

    case 'user': {
      const message = isObj(raw.message) ? raw.message : {}
      const content = Array.isArray(message.content) ? message.content : []
      let next = state
      const uuid = str(raw.uuid)
      // The echo of a message this page sent is already shown.
      const echo = uuid !== undefined && state.items.some(i => i.id === uuid)
      const compact = next.items.findLast(i => i.kind === 'compact')
      if (
        compact?.kind === 'compact' &&
        compact.summary === undefined &&
        (raw.isCompactSummary === true || COMPACT_SUMMARY.test(contentText(message.content)))
      ) {
        return {
          ...next,
          items: next.items.map(i => (i === compact ? { ...compact, summary: contentText(message.content) } : i)),
        }
      }
      const queued = uuid === undefined ? undefined : state.queued.find(q => q.id === uuid)
      if (raw.isReplay === true && queued) {
        // Fed to the model between tool calls.
        const rest = { ...next, queued: next.queued.filter(q => q !== queued) }
        return addUserMessage(rest, queued.text, queued.images, queued.id)
      }
      if (raw.isReplay === true && !echo) {
        const at = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN
        if (next.startedAt === undefined && Number.isFinite(at)) next = { ...next, startedAt: at }
        const text = contentText(message.content)
        const images = content
          .map(part => (isObj(part) && part.type === 'image' ? imageDataUrl(part) : undefined))
          .filter((u): u is string => !!u)
        const itemId = uuid ?? `user-${next.items.length}`
        const fromTeammates = teammateMessages(text, itemId)
        const fromChannel = channelMessage(text, itemId)
        const local = localCommandOutput(text)
        const command = commandInput(text)
        const notified = noteFromLog(next, text, itemId)
        if (notified) {
          next = { ...next, ...notified }
        } else if (/^\[Request interrupted by user( for tool use)?\]$/.test(text.trim())) {
          next = { ...next, items: [...next.items, { kind: 'note', id: itemId, text: '', key: 'interrupted' }] }
        } else if (fromTeammates.length) {
          next = { ...next, items: [...next.items, ...fromTeammates] }
        } else if (fromChannel) {
          next = { ...next, items: [...next.items, fromChannel] }
        } else if (local) {
          if (local.text) next = addLocal(next, { kind: 'local', id: itemId, ...local })
        } else if (command !== undefined) {
          // A reloaded transcript has the `/compact` after its mark; the mark stands for it.
          const marked = /^\/compact(\s|$)/.test(command) && next.items.at(-1)?.kind === 'compact'
          if (!marked) next = { ...next, items: [...next.items, { kind: 'user', id: itemId, text: command }] }
        } else if (text || images.length) {
          next = {
            ...next,
            items: [
              ...next.items,
              {
                kind: 'user',
                id: uuid ?? `user-${next.items.length}`,
                text,
                ...(images.length && { images }),
              },
            ],
          }
        }
      }
      // Keep only the patch of a file edit's result; it also carries the whole file.
      const result = isObj(raw.tool_use_result) ? raw.tool_use_result : undefined
      const meta =
        result && (Array.isArray(result.structuredPatch) || result.type === 'create')
          ? {
              ...(typeof result.type === 'string' && { type: result.type }),
              ...(Array.isArray(result.structuredPatch) && { structuredPatch: result.structuredPatch }),
            }
          : undefined
      for (const part of content) {
        if (!isObj(part) || part.type !== 'tool_result') continue
        const toolId = str(part.tool_use_id)
        if (!toolId) continue
        next = mapTool(next, toolId, b => ({
          ...b,
          result: toolResultText(part.content),
          isError: part.is_error === true,
          ...(meta && { meta }),
        }))
      }
      return next
    }

    case 'result': {
      if (typeof raw.total_cost_usd === 'number') {
        state = { ...state, costUsd: raw.total_cost_usd }
      }
      const failed = raw.is_error === true || raw.subtype !== 'success'
      const next = {
        ...state,
        busy: false,
        // A background worker outlives the turn that started it, and so does its request.
        approvals: state.approvals.filter(a => a.agentId),
        streamingId: undefined,
        recapPending: undefined,
      }
      if (!failed) return next
      const all = Array.isArray(raw.errors) ? raw.errors.filter(e => typeof e === 'string') : []
      // QueryEngine prefixes errors with an internal `[ede_diagnostic]` line; an interrupted turn has nothing else.
      const shown = all.filter(e => !e.startsWith('[ede_diagnostic]'))
      if (all.length && !shown.length && !str(raw.result)) {
        return { ...next, items: [...next.items, { kind: 'note', id: `interrupted-${next.items.length}`, text: '', key: 'interrupted' }] }
      }
      const text = str(raw.result) || shown.join('\n') || String(raw.subtype)
      // An API error already arrived as its own message this turn.
      const lastUser = next.items.findLastIndex(i => i.kind === 'user')
      if (next.items.slice(lastUser + 1).some(i => i.kind === 'error' && i.text === text)) {
        return next
      }
      return addError(next, text)
    }

    case 'control_request': {
      const request = isObj(raw.request) ? raw.request : {}
      const requestId = str(raw.request_id)
      if (request.subtype !== 'can_use_tool' || !requestId) return state
      return {
        ...state,
        approvals: [
          ...state.approvals,
          {
            requestId,
            toolName: str(request.tool_name) ?? '',
            input: isObj(request.input) ? request.input : {},
            suggestions: Array.isArray(request.permission_suggestions)
              ? request.permission_suggestions
              : [],
            ...(str(request.tool_use_id) && { toolUseId: str(request.tool_use_id) }),
            ...(str(request.agent_id) && { agentId: str(request.agent_id) }),
          },
        ],
      }
    }

    case 'control_response':
      return reduceControlResponse(state, raw)

    case 'rate_limit_event': {
      const info = isObj(raw.rate_limit_info) ? raw.rate_limit_info : {}
      const type = str(info.rateLimitType) ?? 'unknown'
      return {
        ...state,
        rateLimits: {
          ...state.rateLimits,
          [type]: {
            type,
            ...(typeof info.utilization === 'number' && { utilization: info.utilization }),
            ...(typeof info.resetsAt === 'number' && { resetsAt: info.resetsAt }),
          },
        },
      }
    }

    default:
      return state
  }
}

// Requests the page sends carry an id prefix naming what the answer is for.
export const REQUEST_PREFIX = {
  initialize: 'web-init-',
  context: 'web-context-',
  mode: 'web-mode-',
  model: 'web-model-',
  interrupt: 'web-interrupt-',
  stopTask: 'web-stop-task-',
  taskMessage: 'web-task-message-',
  settings: 'web-settings-',
  usage: 'web-usage-',
  effort: 'web-effort-',
  status: 'web-status-',
  rewind: 'web-rewind-',
  cancelQueued: 'web-cancel-queued-',
  /** The sidebar dialogs' requests (mcp_status, reload_plugins…). */
  ext: 'web-ext-',
  background: 'web-bg-',
} as const

export type Todo = { content: string; status: string; activeForm?: string }

/**
 * The todo list: the latest TodoWrite call's list, or, on sessions that plan
 * with TaskCreate / TaskUpdate instead, the tasks those calls left.
 */
export function currentTodos(items: Item[]): Todo[] {
  let todos: (Todo & { id?: string })[] = []
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block.kind !== 'tool' || block.isError) continue
      let input: Record<string, unknown>
      try {
        input = JSON.parse(block.input) as Record<string, unknown>
      } catch {
        // Still streaming; the list so far stands.
        continue
      }
      if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
        todos = input.todos.filter(isObj).map(t => ({
          content: str(t.content) ?? '',
          status: str(t.status) ?? 'pending',
          ...(str(t.activeForm) && { activeForm: str(t.activeForm) }),
        }))
      } else if (block.name === 'TaskCreate') {
        const id = /^Task #(\S+) created/.exec(block.result ?? '')?.[1]
        if (!id) continue
        todos.push({ id, content: str(input.subject) ?? '', status: 'pending', ...(str(input.activeForm) && { activeForm: str(input.activeForm) }) })
      } else if (block.name === 'TaskUpdate' && block.result !== undefined) {
        const status = str(input.status)
        if (status === 'deleted') {
          todos = todos.filter(t => t.id !== str(input.taskId))
          continue
        }
        todos = todos.map(t =>
          t.id === str(input.taskId)
            ? {
                ...t,
                ...(status && { status }),
                ...(str(input.subject) && { content: str(input.subject) }),
                ...(str(input.activeForm) && { activeForm: str(input.activeForm) }),
              }
            : t,
        )
      }
    }
  }
  return todos.map(t => ({ content: t.content, status: t.status, ...(t.activeForm && { activeForm: t.activeForm }) }))
}

/** The team the lead created (TeamCreate `team_name`), if any. */
export function teamName(items: Item[]): string | undefined {
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block?.kind !== 'tool' || block.name !== 'TeamCreate') continue
      try {
        const name = (JSON.parse(block.input) as { team_name?: unknown }).team_name
        if (typeof name === 'string' && name) return name
      } catch {
        // Still streaming.
      }
    }
  }
  return undefined
}

/** Settings `hooks` ({ Event: [{ matcher, hooks: [{ command, timeout }] }] }) as flat rows. */
function hooksFrom(raw: unknown): Hook[] {
  if (!isObj(raw)) return []
  return Object.entries(raw).flatMap(([event, matchers]) =>
    (Array.isArray(matchers) ? matchers : []).filter(isObj).flatMap(m =>
      (Array.isArray(m.hooks) ? m.hooks : []).filter(isObj).map(h => ({
        event,
        matcher: str(m.matcher) ?? '',
        command: str(h.command) ?? str(h.prompt) ?? str(h.type) ?? '',
        ...(typeof h.timeout === 'number' && { timeout: h.timeout }),
      })),
    ),
  )
}

function reduceControlResponse(state: ChatState, raw: Json): ChatState {
  const response = isObj(raw.response) ? raw.response : {}
  const id = str(response.request_id) ?? ''
  if (response.subtype === 'error') {
    if (
      id.startsWith(REQUEST_PREFIX.mode) ||
      id.startsWith(REQUEST_PREFIX.model) ||
      id.startsWith(REQUEST_PREFIX.effort)
    ) {
      return { ...state, notice: str(response.error) ?? 'Request failed' }
    }
    return state
  }
  const body = isObj(response.response) ? response.response : {}
  if (id.startsWith(REQUEST_PREFIX.initialize)) {
    const commands = Array.isArray(body.commands)
      ? body.commands.filter(isObj).map(c => ({
          name: str(c.name) ?? '',
          description: str(c.description) ?? '',
          argumentHint: str(c.argumentHint) ?? '',
          ...(Array.isArray(c.aliases) && {
            aliases: c.aliases.filter(a => typeof a === 'string'),
          }),
        }))
      : []
    const account = isObj(body.account) ? body.account : undefined
    return {
      ...state,
      models: parseModels(body.models),
      commands: commands.filter(c => c.name),
      env: {
        ...state.env,
        ...withoutUndefined({
          version: str(body.claude_code_version),
          account: account
            ? withoutUndefined({
                email: str(account.email),
                subscriptionType: str(account.subscriptionType),
                apiKeySource: str(account.apiKeySource),
                apiProvider: str(account.apiProvider),
              })
            : undefined,
        }),
      },
    }
  }
  if (id.startsWith(REQUEST_PREFIX.settings)) {
    const effective = isObj(body.effective) ? body.effective : {}
    const applied = isObj(body.applied) ? body.applied : {}
    return {
      ...state,
      // A reattached page is sent the session's first init; `applied` has the model in use now.
      model: str(applied.model) ?? state.model,
      effort: str(applied.effort) ?? state.effort,
      env: {
        ...state.env,
        uiName: str(effective.uiName),
        hooks: hooksFrom(effective.hooks),
        planMode: effective.planModeAvailable === true,
      },
    }
  }
  if (id.startsWith(REQUEST_PREFIX.context)) {
    const context = contextUsage(body)
    if (context) return { ...state, context, contextPercent: context.percent }
    return typeof body.percentUsed === 'number'
      ? { ...state, contextPercent: body.percentUsed }
      : state
  }
  if (id.startsWith(REQUEST_PREFIX.mode)) {
    return { ...state, notice: undefined, permissionMode: str(body.mode) ?? state.permissionMode }
  }
  if (id.startsWith(REQUEST_PREFIX.model)) return { ...state, notice: undefined }
  return state
}

export function setLocal(
  state: ChatState,
  patch: Partial<Pick<ChatState, 'permissionMode' | 'model' | 'notice' | 'effort'>>,
): ChatState {
  return { ...state, ...patch }
}

/** Control requests the page cannot answer yet get an error, so the session never waits on them. */
export function unsupportedControlResponse(raw: unknown): Json | undefined {
  if (!isObj(raw) || raw.type !== 'control_request') return undefined
  const request = isObj(raw.request) ? raw.request : {}
  const requestId = str(raw.request_id)
  if (!requestId || request.subtype === 'can_use_tool') return undefined
  return {
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: requestId,
      error: `Unsupported control request: ${String(request.subtype)}`,
    },
  }
}

export type ApprovalChoice = 'allow' | 'always' | 'deny'

export function permissionResponse(
  approval: Approval,
  choice: ApprovalChoice,
): Json {
  const response =
    choice === 'deny'
      ? { behavior: 'deny', message: 'The user denied this tool use.' }
      : {
          behavior: 'allow',
          updatedInput: approval.input,
          ...(choice === 'always' && approval.suggestions.length
            ? { updatedPermissions: approval.suggestions }
            : {}),
        }
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: approval.requestId, response },
  }
}

/** A random v4 UUID; crypto.randomUUID needs a secure context. */
export function newUuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const hex = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * `images` are `data:image/…;base64,…` URLs, sent as image blocks. `uuid`
 * lets the page recognise the session's echo of this message.
 */
export function userMessage(text: string, images: string[] = [], uuid?: string): Json {
  const blocks = images.flatMap(url => {
    const match = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(url)
    return match
      ? [{ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }]
      : []
  })
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    ...(uuid && { uuid }),
    message: {
      role: 'user',
      content: [...blocks, ...(text ? [{ type: 'text', text }] : [])],
    },
  }
}

export function controlRequest(
  id: string,
  request: Record<string, unknown>,
): Json {
  return { type: 'control_request', request_id: id, request }
}
