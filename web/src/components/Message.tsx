import { createContext, Fragment, memo, type ReactNode, type RefObject, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AgentTask,
  type Team,
  formatDuration,
  formatTokens,
  isFinished,
  taskName,
  teamColor,
  teammateEvent,
} from '../agents'
import { type DiffRow, toolDiff } from '../diff'
import { baseName, splitMentions, tilde } from '../files'
import type { MessageKey } from '../i18n'
import { Markdown } from '../markdown/Markdown'
import { addUsage, type Block, type Decision, hookBlock, type Item, type ModelOption, type Usage, usageTotal } from '../protocol'
import type { Source } from '../sources'
import { stripAnsi, toolMessage, toolSummary } from '../tools'
import { firstPreviewUrl, WebPreviewContext } from '../webPreview'
import type { Control } from './extShared'
import { McpApp } from './McpApp'
import { ModSite } from './Mods'

/** `claude-opus-5-5` → `Opus 5.5`; anything else is shown as is. */
export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-|\[|$)/.exec(
    model,
  )
  if (!match) return model
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1)
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ''}`
}

/**
 * The models list entry for a model id: an exact value first, then a named
 * entry that resolves to it (the `default` entry's label is not a model name).
 */
export function modelOption(
  model: string | undefined,
  models: ModelOption[],
): ModelOption | undefined {
  if (!model) return undefined
  return (
    models.find(m => m.value === model && m.value !== 'default') ??
    models.find(m => m.value !== 'default' && m.resolvedModel === model) ??
    (model === 'default' ? models.find(m => m.value === 'default') : undefined)
  )
}

/**
 * What the page calls a model, from the models list when it has the model:
 * the versioned name its description leads with (`Opus 5.5 · …` for `Opus`),
 * else its display name.
 */
export function modelName(model: string | undefined, models: ModelOption[]): string | undefined {
  const option = modelOption(model, models)
  if (!option) return modelLabel(model)
  // `Opus 5.5 · Best for…`: the part before ` · ` is the full name. A plain sentence
  // (`GPT-6.1 Terra Codex model.`) is only the description.
  const parts = option.description?.split(' · ') ?? []
  const lead = parts.length > 1 ? parts[0] : undefined
  return lead?.startsWith(`${option.displayName} `) ? lead : option.displayName
}

/** Lets messages open files in the artifact view of the current session. */
export const FilesContext = createContext<{
  open?: (path: string) => void
  /** Opens a message's image in the artifact view; `target` names it in comments. */
  openImage?: (src: string, n: number, target: string) => void
  base?: string
  /** Opens the side panel's Files tab. */
  showFiles?: () => void
  cwd?: string
}>({})

/** How a comment names a message's image: `image 2 of my message "Fix the header…"`. */
export function imageTarget(text: string, index: number): string {
  // `@/long/path/a.md` mentions read as their file names.
  const flat = text
    .replace(/@"([^"]*)"|@(\S+)/g, (_, quoted: string | undefined, bare: string | undefined) =>
      (quoted ?? bare ?? '').split(/[\\/]/).pop() ?? '',
    )
    .replace(/\s+/g, ' ')
    .trim()
  const snippet = flat.length > 40 ? `${flat.slice(0, 40)}…` : flat
  return `image ${index + 1} of my message${snippet ? ` "${snippet}"` : ''}`
}

/** `notes/a.md` for a file under `cwd`, else the `~` form. */
export function relativeTo(path: string, cwd: string | undefined): string {
  const root = cwd?.replace(/[\\/]+$/, '')
  // Windows paths separate with `\`.
  if (root && path.startsWith(root) && /[\\/]/.test(path.charAt(root.length))) return path.slice(root.length + 1)
  return tilde(path)
}

/** The tool's one-line summary, with its file path relative to the chat folder. */
function shortSummary(block: Extract<Block, { kind: 'tool' }>, cwd: string | undefined): string {
  const summary = toolSummary(block.name, block.input)
  const path = toolFilePath(block.name, block.input)
  return path && summary.includes(path) ? summary.replace(path, relativeTo(path, cwd)) : summary
}

/**
 * Per-chat state the messages draw: approval answers by tool use id, and the
 * rewind of a user message (`ask` opens the confirmation above it).
 */
export const ChatContext = createContext<{
  decisions?: Record<string, Decision>
  rewind?: {
    target?: string
    /** The prompts the session's /rewind lists; only these show Rewind. */
    points: Set<string>
    turnsAfter: (id: string) => number
    ask: (id: string | undefined) => void
    go: (id: string, files: boolean) => void
  }
  /** The actions under a reply, by the turn's first message id. */
  turn?: {
    /** The reply answers a prompt that can be rewound to (Retry and Rewind need one). */
    hasPrompt: (id: string) => boolean
    retry: (id: string) => void
    fork: (id: string) => void
    rewind: (id: string) => void
  }
  /** Control requests to the live session (MCP Apps read their resource and call tools with it). */
  control?: Control
}>({})

/** Puts text into the chat's composer as a quote to reply to; only the session's own feed offers it. */
export const QuoteContext = createContext<((text: string) => void) | undefined>(undefined)

/** The prompt for a reply: the quote as a Markdown blockquote, then what was typed. */
export function quotePrompt(quote: string, text: string): string {
  const lines = quote.trim().split(/\r?\n/).map(line => (line ? `> ${line}` : '>'))
  return `${lines.join('\n')}\n\n${text}`
}

/** What a box sends: a slash command goes out as typed, anything else carries the quote it replies to. */
export function replyPrompt(quote: string | undefined, text: string): string {
  return quote && !text.startsWith('/') ? quotePrompt(quote, text) : text
}

/** A prompt that opens with a blockquote: the quoted text and what follows it. */
export function splitQuote(text: string): { quote?: string; rest: string } {
  const m = /^((?:>[^\n]*\n)+)\n([\s\S]*)$/.exec(text)
  if (!m || !m[2]!.trim()) return { rest: text }
  return { quote: m[1]!.replace(/^> ?/gm, '').trimEnd(), rest: m[2]! }
}

/** A subagent's or worker's own conversation: the session's rewind and turn actions are not its own. */
export function AgentConversation({ children }: { children: ReactNode }) {
  const { decisions } = useContext(ChatContext)
  const value = useMemo(() => ({ decisions }), [decisions])
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
}

/** A message the user sent an agent, shown before its conversation has it. */
export type SentMessage = { id: string; text: string }

/**
 * The sent messages the agent's conversation does not have yet, in order.
 * Each is matched to one user message after where the conversation stood
 * when it was first seen here; `drop` gets the ones that matched.
 */
export function useUnread(items: Item[], sent: SentMessage[], drop: (ids: string[]) => void): SentMessage[] {
  const from = useRef(new Map<string, number>())
  for (const m of sent) if (!from.current.has(m.id)) from.current.set(m.id, items.length)
  const unread = useMemo(() => {
    const claimed = new Set<number>()
    return sent.filter(m => {
      const start = from.current.get(m.id) ?? 0
      const at = items.findIndex((i, n) => n >= start && !claimed.has(n) && i.kind === 'user' && i.text === m.text)
      if (at < 0) return true
      claimed.add(at)
      return false
    })
  }, [sent, items])
  useEffect(() => {
    if (unread.length !== sent.length) drop(sent.filter(m => !unread.includes(m)).map(m => m.id))
  }, [unread, sent, drop])
  return unread
}

/** Lets an Agent tool card show its task and open it in the Agents tab. */
export const AgentsContext = createContext<{
  byToolUse?: Map<string, AgentTask>
  /** The agent a SendMessage call's input addressed. */
  sentTo?: (input: string) => AgentTask | undefined
  open?: (taskId: string) => void
}>({})

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

function toolFilePath(name: string, input: string): string | undefined {
  if (!FILE_TOOLS.has(name)) return undefined
  try {
    const parsed = JSON.parse(input) as { file_path?: unknown; notebook_path?: unknown }
    const path = parsed.file_path ?? parsed.notebook_path
    return typeof path === 'string' ? path : undefined
  } catch {
    return undefined
  }
}

function UserText({ text: full }: { text: string }) {
  const files = useContext(FilesContext)
  const { quote, rest: text } = splitQuote(full)
  return (
    <>
      {quote !== undefined && <span className="uquote">{quote}</span>}
      {splitMentions(text).map((seg, i) =>
        'path' in seg ? (
          <button
            type="button"
            key={i}
            className="file-chip"
            title={seg.path}
            onClick={() => files.open?.(seg.path)}
          >
            {baseName(seg.path)}
          </button>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}

function parsedInput(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

// A new file shows this many lines until "show more".
const NEW_FILE_ROWS = 6

function DiffLine({ row }: { row: DiffRow }) {
  if (row.kind === 'hunk') {
    return (
      <span className="dl dh">
        <i />
        <i />
        <i />
        <span>{row.text}</span>
      </span>
    )
  }
  return (
    <span className={`dl ${row.kind}`}>
      <i>{row.old}</i>
      <i>{row.new}</i>
      <i className="s">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</i>
      <span>{row.text}</span>
    </span>
  )
}

/** The prototype's `.diffview` rows of a file tool, with its footer. */
function DiffBody({
  diff,
  path,
  t,
}: {
  diff: NonNullable<ReturnType<typeof toolDiff>>
  path?: string
  t: T
}) {
  const files = useContext(FilesContext)
  const [more, setMore] = useState(false)
  const fold = diff.created && diff.rows.length > NEW_FILE_ROWS
  const shown = fold ? diff.rows.slice(0, NEW_FILE_ROWS) : diff.rows
  const rest = fold ? diff.rows.slice(NEW_FILE_ROWS) : []
  return (
    <>
      <pre className="diffview" data-notr="">
        {shown.map((row, i) => (
          <DiffLine key={i} row={row} />
        ))}
        {fold && (
          <span className="dlmore" hidden={!more}>
            {more && rest.map((row, i) => <DiffLine key={i} row={row} />)}
          </span>
        )}
      </pre>
      {fold && !more ? (
        <div className="tfoot">
          <button type="button" className="linkbtn" onClick={() => setMore(true)}>
            {t('showMoreLines', { n: String(rest.length) })}
          </button>
        </div>
      ) : (
        !diff.created &&
        path && (
          <div className="tfoot">
            {files.open ? (
              <button type="button" className="pathlink" title={path} onClick={() => files.open?.(path)}>
                {tilde(path)}
              </button>
            ) : (
              <span>{tilde(path)}</span>
            )}
            {files.showFiles && (
              <>
                <span>·</span>
                <button type="button" className="linkbtn" onClick={files.showFiles}>
                  {t('viewInFiles')}
                </button>
              </>
            )}
          </div>
        )
      )}
    </>
  )
}

/** "Allowed once" where an answered approval was asked. */
export function decisionText(decision: Decision, t: T): string {
  if (decision.choice === 'deny') return t('decisionDeny')
  if (decision.choice === 'allow') return t('decisionAllow')
  return [t('decisionAlways'), decision.rules].filter(Boolean).join(' ')
}

type T = (key: MessageKey, vars?: Record<string, string>) => string

function resultProps(block: Extract<Block, { kind: 'tool' }>) {
  return { tool_use_id: block.id, tool: block.name, output: block.result ?? '', isErrored: block.isError === true, isExpanded: true }
}

function ToolCard({ block, t }: { block: Extract<Block, { kind: 'tool' }>; t: T }) {
  const files = useContext(FilesContext)
  const agents = useContext(AgentsContext)
  const web = useContext(WebPreviewContext)
  const chat = useContext(ChatContext)
  const path = files.open && !block.isError ? toolFilePath(block.name, block.input) : undefined
  const webUrl =
    !path && block.result && web.target && web.open
      ? firstPreviewUrl(stripAnsi(block.result), web.target)
      : undefined
  const sentTo = block.name === 'SendMessage' && !block.isError ? agents.sentTo?.(block.input) : undefined
  const task = agents.byToolUse?.get(block.id) ?? sentTo
  const done = block.result !== undefined
  const diff = block.isError ? undefined : toolDiff(block.name, block.input, block.meta)
  const message = toolMessage(block.name, block.input)
  const decision = chat.decisions?.[block.id]
  const card = (
    <details className={`toolcard${block.isError ? ' bad' : ''}`} open={diff && !diff.created ? true : undefined}>
      <summary>
        <span className="tname">{block.name}</span>
        {path ? (
          // The file path opens the file, as the prototype's data-file links do.
          <button
            type="button"
            className="tcmd pathlink"
            title={path}
            onClick={e => {
              e.preventDefault()
              files.open?.(path)
            }}
          >
            {shortSummary(block, files.cwd)}
          </button>
        ) : (
          <span className="tcmd">
            {block.name === 'TodoWrite'
              ? t('todosUpdated')
              : sentTo
                ? `${t('sentTo')} ${sentTo.title ?? sentTo.description}`
                : shortSummary(block, files.cwd)}
          </span>
        )}
        <span className="tacts">
          {task && (
            <button
              type="button"
              className={`chipbtn agent-chip agent-${task.status}`}
              onClick={e => {
                e.preventDefault()
                agents.open?.(task.id)
              }}
            >
              {taskName(task)} ·{' '}
              {isFinished(task) ? task.status : (formatDuration(task.durationMs) ?? task.status)}
            </button>
          )}
          {decision && <span className="tdec">{decisionText(decision, t)}</span>}
          {webUrl && (
            <button
              type="button"
              className="chipbtn tool-preview"
              title={webUrl}
              onClick={e => {
                e.preventDefault()
                web.open?.(webUrl)
              }}
            >
              {t('preview')}
            </button>
          )}
        </span>
        {diff && done ? (
          <span className="tstat">
            <span className="dstat add">+{diff.added}</span>
            {diff.created ? <span>{t('newFile')}</span> : <span className="dstat del">−{diff.removed}</span>}
          </span>
        ) : (
          <span className={`tstat${done ? (block.isError ? ' bad' : ' ok') : ''}`}>
            {done ? (block.isError ? '✗' : '✓') : <span className="spin" aria-hidden="true" />}
          </span>
        )}
      </summary>
      {diff ? (
        <DiffBody diff={diff} path={toolFilePath(block.name, block.input)} t={t} />
      ) : message ? (
        <div className="tbody">
          <Markdown filesBase={files.base} text={message} />
          {done && (
            <ModSite component="ToolResult" id={block.id} props={resultProps(block)}>
              {p => <div className="tlabel">{stripAnsi(String(p.output))}</div>}
            </ModSite>
          )}
        </div>
      ) : (
        <div className="tbody">
          <div className="tlabel">{t('toolInput')}</div>
          <pre className="tin">{prettyJson(block.input)}</pre>
          {done && (
            <ModSite component="ToolResult" id={block.id} props={resultProps(block)}>
              {p => (
                <>
                  <div className="tlabel">{t('toolOutput')}</div>
                  <pre className="tout">{stripAnsi(String(p.output))}</pre>
                </>
              )}
            </ModSite>
          )}
        </div>
      )}
    </details>
  )
  const app = block.name.startsWith('mcp__') && chat.control ? <McpApp block={block} control={chat.control} t={t} /> : null
  const blocked = block.isError && block.result ? hookBlock(block.result) : undefined
  if (!blocked) return app ? <>{card}{app}</> : card
  // As the TUI's line under the tool call; the tool result is all a reloaded transcript keeps of it.
  return (
    <>
      {card}
      <div className="pj-note event-line error tool-hook">
        <span className="g">⚑</span>
        <span>{t(blocked.why ? 'hookBlockedWhy' : 'hookBlocked', blocked)}</span>
      </div>
    </>
  )
}

/** A worker's report to its caller (`SubagentHandback`), unless it was refused. */
function handbackReport(block: Block | undefined): string | undefined {
  if (block?.kind !== 'tool' || block.name !== 'SubagentHandback' || block.isError) return undefined
  if (block.result?.includes('"success":false')) return undefined
  return toolMessage(block.name, block.input)
}

/** How a teammate protocol message reads; plain messages have no label. */
export function teamEventLabel(
  type: string | undefined,
  t: (key: MessageKey) => string,
): string | undefined {
  if (!type) return undefined
  return type === 'idle_notification' ? t('teamIdle') : type.replace(/_/g, ' ')
}

export function TeamDot({ color }: { color?: string }) {
  return <span className="team-dot" style={{ background: teamColor(color) }} />
}

const AVATAR_COLORS = ['#3b6fd8', '#2c9a5a', '#9a8a2c', '#8a5ab8', '#c0563a', '#2a8a9a']

/** The `.teambar` under the meta row: one avatar per teammate, opening its chat. */
export function TeamBar({
  t,
  team,
  name,
  onOpen,
}: {
  t: T
  team: Team
  name?: string
  onOpen: (taskId: string) => void
}) {
  return (
    <div className="teambar" aria-label="Agent Team">
      <span>
        team{name && <b> {name}</b>}
      </span>
      {team.members.map((m, i) => (
        <button
          type="button"
          key={m.task.id}
          className="avatar"
          style={{ background: m.color ?? AVATAR_COLORS[i % AVATAR_COLORS.length] }}
          title={`${m.name} · ${m.state === 'stopped' ? t('statusKilled') : m.state}`}
          onClick={() => onOpen(m.task.id)}
        >
          {m.name.charAt(0).toUpperCase()}
        </button>
      ))}
      <span className="note">{t('teamNote')}</span>
    </div>
  )
}

const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'ToolSearch'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch'])

/** What a folded run of tool calls did, in words: "Read 3 files", "Ran bun test". */
export function stepActions(tools: Extract<Block, { kind: 'tool' }>[], t: T): string[] {
  const count = (set: Set<string>) => tools.filter(b => set.has(b.name))
  const files = new Set(count(READ_TOOLS).map(b => toolSummary(b.name, b.input)))
  const shell = count(SHELL_TOOLS)
  const edits = new Set(count(FILE_TOOLS).filter(b => !READ_TOOLS.has(b.name)).map(b => toolSummary(b.name, b.input)))
  const known = new Set([...READ_TOOLS, ...SEARCH_TOOLS, ...SHELL_TOOLS, ...WEB_TOOLS, ...FILE_TOOLS])
  const other = [...new Set(tools.filter(b => !known.has(b.name)).map(b => b.name))]
  const command = shell.length === 1 ? toolSummary(shell[0]!.name, shell[0]!.input) : ''
  return [
    files.size ? t('stepsRead', { n: String(files.size) }) : '',
    count(SEARCH_TOOLS).length ? t('stepsSearched', { n: String(count(SEARCH_TOOLS).length) }) : '',
    shell.length === 1 ? t('stepsRanOne', { cmd: command.length > 48 ? `${command.slice(0, 47)}…` : command }) : '',
    shell.length > 1 ? t('stepsRan', { n: String(shell.length) }) : '',
    edits.size ? t('stepsEdited', { n: String(edits.size) }) : '',
    count(WEB_TOOLS).length ? t('stepsWeb', { n: String(count(WEB_TOOLS).length) }) : '',
    other.join(', '),
  ].filter(Boolean)
}

const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000))

/**
 * Each API message is its own item; consecutive assistant items are one turn,
 * drawn as one message. `ids` are the joined items; `splitAfter` ends a turn early.
 */
export function joinTurns(items: Item[], splitAfter?: (id: string) => boolean): { item: Item; ids: string[] }[] {
  const out: { item: Item; ids: string[] }[] = []
  for (const item of items) {
    const last = out.at(-1)
    if (item.kind === 'assistant' && last?.item.kind === 'assistant' && !splitAfter?.(last.ids.at(-1)!)) {
      last.item = {
        ...last.item,
        blocks: [...last.item.blocks, ...item.blocks],
        usage: addUsage(last.item.usage, item.usage),
        turnUsage: addUsage(last.item.turnUsage, item.turnUsage),
      }
      last.ids.push(item.id)
    } else {
      out.push({ item, ids: [item.id] })
    }
  }
  return out
}

/**
 * How a turn's blocks are drawn: text as is, a run of two or more thinking and
 * tool blocks folded into one steps row, adjacent task cards together, and a
 * block that must stay in sight (a file edit) on its own.
 */
export type Segment = { kind: 'text' | 'step' | 'steps' | 'cards'; at: number[] }

export function turnSegments(
  blocks: (Block | undefined)[],
  isCard: (index: number) => boolean,
  keepShown: (index: number) => boolean = () => false,
): Segment[] {
  const out: Segment[] = []
  blocks.forEach((block, i) => {
    if (!block) return
    const kind = block.kind === 'text' ? 'text' : isCard(i) ? 'cards' : keepShown(i) ? 'step' : 'steps'
    const last = out.at(-1)
    if ((kind === 'cards' || kind === 'steps') && last?.kind === kind) last.at.push(i)
    else out.push({ kind, at: [i] })
  })
  return out.map(s => (s.kind === 'steps' && s.at.length === 1 ? { ...s, kind: 'step' } : s))
}

const sameList = <V,>(a: readonly V[] | undefined, b: readonly V[] | undefined, same = (x: V, y: V) => x === y) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => same(x, b[i]!)))

type MessageProps = Parameters<typeof MessageView>[0]

/**
 * `joinTurns` builds a new item for a multi-message turn on every render, so a
 * turn is the same when its blocks are; a streamed delta then redraws only the
 * message it lands in.
 */
function sameMessage(a: MessageProps, b: MessageProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof MessageProps)[])
  for (const key of keys) {
    if (key === 'item' || key === 'sources' || a[key] === b[key]) continue
    return false
  }
  // Sources are found again on every update; the same links are the same list.
  if (!sameList(a.sources, b.sources, (x, y) => x.url === y.url && x.title === y.title)) return false
  const x = a.item
  const y = b.item
  if (x === y) return true
  return (
    x.kind === 'assistant' &&
    y.kind === 'assistant' &&
    x.id === y.id &&
    x.model === y.model &&
    x.streamed === y.streamed &&
    sameList(x.blocks, y.blocks) &&
    usageTotal(x.turnUsage ?? x.usage ?? NO_USAGE) === usageTotal(y.turnUsage ?? y.usage ?? NO_USAGE)
  )
}

const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export const Message = memo(MessageView, sameMessage)

function MessageView({
  item,
  t,
  fallbackModel,
  models = [],
  streaming,
  sources,
  role,
  who = 'Claude',
  taskCard,
  queued,
}: {
  item: Item
  t: T
  fallbackModel?: string
  models?: ModelOption[]
  streaming: boolean
  sources?: Source[]
  /** After the model in the label: ` · 协调者` in a project. */
  role?: string
  /** Who speaks, in place of `Claude` (a project task's `worker`). */
  who?: string
  /** A project draws its Agent calls as one-line task cards, grouped after the text. */
  taskCard?: (block: Extract<Block, { kind: 'tool' }>) => ReactNode
  /** Sent during a running turn and not yet seen by the model. */
  queued?: boolean
}) {
  const files = useContext(FilesContext)
  const { rewind, turn } = useContext(ChatContext)
  const quote = useContext(QuoteContext)
  const [copied, setCopied] = useState(false)
  if (item.kind === 'user') {
    const asking = rewind?.target === item.id
    return (
      <>
        {asking && (
          <div className="rw-confirm" onKeyDown={e => e.key === 'Escape' && rewind.ask(undefined)}>
            <b>{t('rewindAsk')}</b>
            <span className="note">{t('rewindNote', { n: String(rewind.turnsAfter(item.id)) })}</span>
            <span className="btns">
              <button className="btn primary" type="button" autoFocus onClick={() => rewind.go(item.id, false)}>
                {t('rewindConversation')}
              </button>
              <button className="btn" type="button" onClick={() => rewind.go(item.id, true)}>
                {t('rewindWithFiles')}
              </button>
              <button className="btn" type="button" onClick={() => rewind.ask(undefined)}>
                {t('cancel')}
              </button>
            </span>
          </div>
        )}
        <ModSite
          component="UserMessage"
          id={item.id}
          off={queued}
          props={{ text: item.text, origin: { kind: 'composer' }, isExpanded: true }}
        >
          {p => (
            <div className={queued ? 'msg user queued' : 'msg user'}>
              {rewind?.points.has(item.id) && !queued && (
                <button type="button" className="rw-btn" title={t('rewindTitle')} onClick={() => rewind.ask(item.id)}>
                  {t('rewind')}
                </button>
              )}
              <span className="who">{queued ? t('queuedMessage') : t('you')}</span>
              <div className="bubble">
                {item.images?.map((src, i) =>
                  files.openImage ? (
                    <button
                      type="button"
                      key={i}
                      className="bubble-image-open"
                      title={t('preview')}
                      onClick={() => files.openImage?.(src, i + 1, imageTarget(item.text, i))}
                    >
                      <img className="bubble-image" src={src} alt="" />
                    </button>
                  ) : (
                    <img key={i} className="bubble-image" src={src} alt="" />
                  ),
                )}
                <UserText text={String(p.text)} />
              </div>
            </div>
          )}
        </ModSite>
      </>
    )
  }
  if (item.kind === 'compact') {
    const time = item.at === undefined ? '' : new Date(item.at).toTimeString().slice(0, 5)
    const tokens = (n: number) => `${Math.round(n / 1000)}k`
    return (
      <div className="compact-mark">
        <div className="rule">
          <span>
            {t('compactedAt', { time, how: item.trigger === 'auto' ? t('compactAuto') : '/compact' }).replace(' ·  · ', ' · ')}
          </span>
        </div>
        {item.summary && (
          <details className="think">
            <summary>
              {item.preTokens !== undefined && item.postTokens !== undefined
                ? t('compactSummary', { from: tokens(item.preTokens), to: tokens(item.postTokens) })
                : t('compactSummaryShort')}
            </summary>
            <div className="tbody">{item.summary}</div>
          </details>
        )}
      </div>
    )
  }
  if (item.kind === 'recap') {
    return (
      <div className="recap">
        <span className="rm">※</span>
        <span>
          {item.away !== undefined && t('recapAway', { n: String(item.away) })}
          {stripAnsi(item.text)}
        </span>
      </div>
    )
  }
  if (item.kind === 'note') {
    return (
      <ModSite component="InfoNotice" id={item.id} props={{ text: item.key ? t(item.key) : item.text, command: null }}>
        {p => (
          <div className="note" style={{ textAlign: 'center' }}>
            {String(p.text)}
          </div>
        )}
      </ModSite>
    )
  }
  if (item.kind === 'goal') {
    const head = t(item.status === 'met' ? 'goalMet' : item.status === 'cleared' ? 'goalCleared' : 'goalFailed')
    return (
      <div className="rule">
        <span>
          {[head, item.iterations !== undefined && t('nChecks', { n: String(item.iterations) }), formatDuration(item.durationMs)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
    )
  }
  if (item.kind === 'teammate') {
    const event = teammateEvent(item.text)
    const label = teamEventLabel(event.type, t)
    return (
      <div className="msg teammate">
        <TeamDot color={item.color} />
        <strong>{item.from}</strong>
        {label && <span className="team-event">{label}</span>}
        <span className="team-text">{event.detail || item.summary}</span>
      </div>
    )
  }
  if (item.kind === 'channel') {
    // Someone outside wrote this through a channel; shown as plain text.
    return (
      <div className="msg channel">
        <span className="who">
          <span className="chan-badge">{item.source}</span> {item.user}
        </span>
        <div className="bubble">{item.text}</div>
      </div>
    )
  }
  if (item.kind === 'peer') {
    // Another Claude session wrote this; shown as plain text, like a channel message.
    return (
      <div className="msg channel">
        <span className="who">
          <span className="chan-badge">{t('peerBadge')}</span> {item.from}
        </span>
        <div className="bubble">{item.text}</div>
      </div>
    )
  }
  if (item.kind === 'event') {
    return (
      <div className={`pj-note event-line${item.tone ? ` ${item.tone}` : ''}`}>
        <span className="g">{item.key === 'cronFired' ? '⏲' : item.key === 'modLog' ? '◆' : '⚑'}</span>
        <span>{t(item.key, item.vars)}</span>
      </div>
    )
  }
  if (item.kind === 'local') {
    return (
      <ModSite
        component="CommandOutput"
        id={item.id}
        props={{ command: item.command ?? '', args: item.args ?? '', text: item.text, isErrored: item.isError === true }}
      >
        {p => (
          <div className={`msg local${item.isError ? ' err' : ''}`}>
            <span className="rm" aria-hidden="true">
              ⎿
            </span>
            <span className="md">{stripAnsi(String(p.text))}</span>
          </div>
        )}
      </ModSite>
    )
  }
  if (item.kind === 'error') {
    return (
      <div className="msg err" role="alert">
        <div className="errbox">{item.text}</div>
      </div>
    )
  }
  const label = modelName(item.model ?? fallbackModel, models)
  const cards = new Map<number, ReactNode>()
  if (taskCard) {
    item.blocks.forEach((block, i) => {
      const card = block?.kind === 'tool' ? taskCard(block) : undefined
      if (card) cards.set(i, card)
    })
  }
  // File changes stay in sight, outside the folded steps.
  const segments = turnSegments(
    item.blocks,
    i => cards.has(i),
    i => {
      const block = item.blocks[i]
      if (handbackReport(block) !== undefined) return true
      return block?.kind === 'tool' && !block.isError && toolDiff(block.name, block.input, block.meta) !== undefined
    },
  )
  const firstText = item.blocks.findIndex(b => b?.kind === 'text')
  // The result's count is the turn's; a reloaded turn sums what its requests recorded.
  const usage = item.turnUsage ?? item.usage
  const step = (i: number) => {
    const block = item.blocks[i]!
    if (block.kind === 'thinking') {
      const live = streaming && block.startedAt !== undefined && block.ms === undefined
      return (
        <details key={`${i}${live ? '-live' : ''}`} className="think" open={live || undefined}>
          <summary className={live ? 'shimmer' : undefined}>
            {live
              ? t('thinkingNow')
              : block.ms !== undefined
                ? t('thoughtFor', { n: String(seconds(block.ms)) })
                : t('thinking')}
          </summary>
          <div className="tbody">{block.text}</div>
        </details>
      )
    }
    const report = handbackReport(block)
    if (report !== undefined && block.kind === 'tool') {
      return (
        <div className="report" key={i}>
          <div className="rh">
            {/* The worker ends with its report, so a saved one may never get a result. */}
            {block.result === undefined && streaming ? <span className="spin" aria-hidden="true" /> : <span className="ok">✓</span>}
            {t('handbackReport')}
          </div>
          <Markdown filesBase={files.base} text={report} />
        </div>
      )
    }
    if (block.kind !== 'tool') return null
    return (
      <ModSite
        key={i}
        component="ToolUse"
        id={block.id}
        props={{
          tool_use_id: block.id,
          tool: block.name,
          input: parsedInput(block.input),
          isRunning: block.result === undefined && streaming,
          isErrored: block.isError === true,
          isInterrupted: block.result === undefined && !streaming,
          isExpanded: false,
          ...(block.result !== undefined && { output: block.result }),
        }}
      >
        {() => <ToolCard block={block} t={t} />}
      </ModSite>
    )
  }
  return (
    <div className="msg assistant">
      <span className="who">
        {who}
        {label && <span className="wm"> ({label})</span>}
        {role}
      </span>
      {segments.map((segment, n) => {
        const first = segment.at[0]!
        if (segment.kind === 'text') {
          const block = item.blocks[first] as Extract<Block, { kind: 'text' }>
          const live = streaming && first === item.blocks.length - 1
          return (
            <ModSite
              key={first}
              component="AssistantMessage"
              id={`${item.id}:${first}`}
              off={live}
              props={{ text: block.text, isFirstOfReply: first === firstText }}
            >
              {p => <Markdown filesBase={files.base} text={String(p.text)} streaming={live} />}
            </ModSite>
          )
        }
        if (segment.kind === 'cards') {
          return (
            <div className="pjcards" key={first}>
              {segment.at.map(i => (
                <Fragment key={i}>{cards.get(i)}</Fragment>
              ))}
            </div>
          )
        }
        if (segment.kind === 'step') return step(first)
        const run = segment.at.map(i => item.blocks[i]!)
        // The run the model is still on stays open, as a thinking row does.
        const live = streaming && n === segments.length - 1
        const tools = run.flatMap(b => (b.kind === 'tool' ? [b] : []))
        const thought = run.reduce((ms, b) => ms + (b.kind === 'thinking' ? (b.ms ?? 0) : 0), 0)
        const failed = tools.filter(b => b.isError).length
        const summaryParts = (ms: number, calls: typeof tools, n: number) => {
          const parts = [ms > 0 ? t('thoughtFor', { n: String(seconds(ms)) }) : '', ...stepActions(calls, t)].filter(Boolean)
          return parts.length ? parts : [t('nSteps', { n: String(n) })]
        }
        return (
          <ModSite
            key={`s${first}${live ? '-live' : ''}`}
            component="ToolGroup"
            id={`${item.id}:s${first}`}
            props={{
              calls: tools.map(b => ({ tool_use_id: b.id, tool: b.name, input: parsedInput(b.input), isErrored: b.isError === true })),
              isActive: live,
              isExpanded: false,
            }}
          >
            {() => (
              <details className="think steps" open={live || undefined}>
                <summary className={live ? 'shimmer' : undefined}>
                  <span className={`sdot ${live ? 'run' : failed ? 'bad' : 'ok'}`} aria-hidden="true" />
                  {summaryParts(thought, tools, run.length)
                    .map((part, k) => (
                      <span key={k} className="sd">
                        {part}
                      </span>
                    ))}
                  {failed > 0 && <span className="sd bad">{t('nFailed', { n: String(failed) })}</span>}
                </summary>
                <div className="stepsbody">{segment.at.map(step)}</div>
              </details>
            )}
          </ModSite>
        )
      })}
      {(turn || quote || usage) && !streaming && (
        <div className="msg-acts">
          <button
            type="button"
            onClick={() => {
              const text = item.blocks.flatMap(b => (b?.kind === 'text' ? [b.text] : [])).join('\n\n')
              void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
          >
            {copied ? t('copied') : t('copy')}
          </button>
          {quote && (
            <button
              type="button"
              onClick={() => quote(item.blocks.flatMap(b => (b?.kind === 'text' ? [b.text] : [])).join('\n\n'))}
            >
              {t('reply')}
            </button>
          )}
          {turn?.hasPrompt(item.id) && (
            <button type="button" onClick={() => turn.retry(item.id)}>
              {t('retry')}
            </button>
          )}
          {turn && (
            <button type="button" onClick={() => turn.fork(item.id)}>
              {t('forkHere')}
            </button>
          )}
          {turn?.hasPrompt(item.id) && (
            <button type="button" onClick={() => turn.rewind(item.id)}>
              {t('rewind')}
            </button>
          )}
          {usage && (
            <span
              className="usage"
              title={t('turnUsage', {
                input: usage.input.toLocaleString(),
                read: usage.cacheRead.toLocaleString(),
                write: usage.cacheWrite.toLocaleString(),
                output: usage.output.toLocaleString(),
              })}
            >
              {formatTokens(usageTotal(usage))}
            </span>
          )}
        </div>
      )}
      {sources && sources.length > 0 && (
        <div className="sources">
          <div>{t('sources')}</div>
          <ol>
            {sources.map(source => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>
                  {source.title ?? new URL(source.url).hostname}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}

/**
 * A Reply button over text selected in a message of the feed (as Claude.ai
 * does): the selection becomes the composer's quote.
 */
export function QuoteOnSelect({ t, feed, onQuote }: { t: T; feed: RefObject<HTMLElement | null>; onQuote: (text: string) => void }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string }>()
  useEffect(() => {
    let frame = 0
    const place = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const sel = document.getSelection()
        const root = feed.current
        const text = sel?.toString().trim()
        if (!sel || !root || sel.isCollapsed || !text || !sel.rangeCount) return setAt(undefined)
        const msgOf = (node: Node | null) =>
          (node instanceof Element ? node : node?.parentElement)?.closest('.msg.assistant, .msg.user:not(.queued)')
        const msg = msgOf(sel.anchorNode)
        if (!msg || !root.contains(msg) || msgOf(sel.focusNode) !== msg) return setAt(undefined)
        const rect = sel.getRangeAt(0).getBoundingClientRect()
        const box = root.getBoundingClientRect()
        if (rect.bottom < box.top || rect.top > box.bottom) return setAt(undefined)
        setAt({ x: rect.left + rect.width / 2, y: Math.max(rect.top, box.top), text })
      })
    }
    // Any scroll moves the selection: the feed itself or a panel around it.
    document.addEventListener('selectionchange', place)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', place)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [feed])
  if (!at) return null
  return (
    <button
      type="button"
      className="quote-pop"
      style={{ left: Math.min(Math.max(at.x, 48), window.innerWidth - 48), top: at.y }}
      // Keep the selection while the button is pressed.
      onMouseDown={e => e.preventDefault()}
      onClick={() => {
        onQuote(at.text)
        document.getSelection()?.removeAllRanges()
        setAt(undefined)
      }}
    >
      {t('reply')}
    </button>
  )
}
