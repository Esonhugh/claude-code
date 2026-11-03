import { createContext, Fragment, type ReactNode, useContext, useState } from 'react'
import {
  type AgentTask,
  type Team,
  formatDuration,
  isFinished,
  taskName,
  teamColor,
  teammateEvent,
} from '../agents'
import { type DiffRow, toolDiff } from '../diff'
import { baseName, splitMentions, tilde } from '../files'
import type { MessageKey } from '../i18n'
import { Markdown } from '../markdown/Markdown'
import type { Block, Decision, Item, ModelOption } from '../protocol'
import type { Source } from '../sources'
import { stripAnsi, toolSummary } from '../tools'
import { firstPreviewUrl, WebPreviewContext } from '../webPreview'

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
  const lead = option.description?.split(' · ')[0]
  return lead?.startsWith(`${option.displayName} `) ? lead : option.displayName
}

/** Lets messages open files in the artifact view of the current session. */
export const FilesContext = createContext<{
  open?: (path: string) => void
  base?: string
  /** Opens the side panel's Files tab. */
  showFiles?: () => void
  cwd?: string
}>({})

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
    turnsAfter: (id: string) => number
    ask: (id: string | undefined) => void
    go: (id: string, files: boolean) => void
  }
}>({})

/** Lets an Agent tool card show its task and open it in the Agents tab. */
export const AgentsContext = createContext<{
  byToolUse?: Map<string, AgentTask>
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

function UserText({ text }: { text: string }) {
  const files = useContext(FilesContext)
  return (
    <>
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
  const task = agents.byToolUse?.get(block.id)
  const done = block.result !== undefined
  const diff = block.isError ? undefined : toolDiff(block.name, block.input, block.meta)
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
          <span className="tcmd">{block.name === 'TodoWrite' ? t('todosUpdated') : shortSummary(block, files.cwd)}</span>
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
      ) : (
        <div className="tbody">
          <div className="tlabel">{t('toolInput')}</div>
          <pre className="tin">{prettyJson(block.input)}</pre>
          {done && (
            <>
              <div className="tlabel">{t('toolOutput')}</div>
              <pre className="tout">{stripAnsi(block.result!)}</pre>
            </>
          )}
        </div>
      )}
    </details>
  )
  if (!decision) return card
  return (
    <>
      {card}
      <div className="ask-ref done">{decisionText(decision, t)}</div>
    </>
  )
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

/** Each API message is its own item; one that follows another assistant item belongs to the same turn. */
export function continuesTurn(items: Item[], index: number): boolean {
  return items[index]?.kind === 'assistant' && items[index - 1]?.kind === 'assistant'
}

export function Message({
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
  continued,
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
  /** Another API message of the turn above: drawn under its header. */
  continued?: boolean
}) {
  const files = useContext(FilesContext)
  const { rewind } = useContext(ChatContext)
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
        <div className={queued ? 'msg user queued' : 'msg user'}>
          {rewind && !queued && (
            <button type="button" className="rw-btn" title={t('rewindTitle')} onClick={() => rewind.ask(item.id)}>
              {t('rewind')}
            </button>
          )}
          <span className="who">{queued ? t('queuedMessage') : t('you')}</span>
          <div className="bubble">
            {item.images?.map((src, i) => (
              <img key={i} className="bubble-image" src={src} alt="" />
            ))}
            <UserText text={item.text} />
          </div>
        </div>
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
      <div className="note" style={{ textAlign: 'center' }}>
        {item.key ? t(item.key) : item.text}
      </div>
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
  if (item.kind === 'local') {
    return (
      <div className={`msg local${item.isError ? ' err' : ''}`}>
        <span className="rm" aria-hidden="true">
          ⎿
        </span>
        <span className="md">{stripAnsi(item.text)}</span>
      </div>
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
  const cards = taskCard
    ? item.blocks.flatMap((block, i) => {
        const card = block?.kind === 'tool' ? taskCard(block) : undefined
        return card ? [{ i, card }] : []
      })
    : []
  return (
    <div className={continued ? 'msg assistant cont' : 'msg assistant'}>
      {!continued && (
        <span className="who">
          {who}
          {label && <span className="wm"> ({label})</span>}
          {role}
        </span>
      )}
      {item.blocks.map((block, i) => {
        if (!block || cards.some(c => c.i === i)) return null
        if (block.kind === 'text') {
          return (
            <Markdown
              key={i}
              filesBase={files.base}
              text={block.text}
              streaming={streaming && i === item.blocks.length - 1}
            />
          )
        }
        if (block.kind === 'thinking') {
          const live = streaming && block.startedAt !== undefined && block.ms === undefined
          return (
            <details key={`${i}${live ? '-live' : ''}`} className="think" open={live || undefined}>
              <summary className={live ? 'shimmer' : undefined}>
                {live
                  ? t('thinkingNow')
                  : block.ms !== undefined
                    ? t('thoughtFor', { n: String(Math.max(1, Math.round(block.ms / 1000))) })
                    : t('thinking')}
              </summary>
              <div className="tbody">{block.text}</div>
            </details>
          )
        }
        return <ToolCard key={i} block={block} t={t} />
      })}
      {cards.length > 0 && <div className="pjcards">{cards.map(c => <Fragment key={c.i}>{c.card}</Fragment>)}</div>}
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
