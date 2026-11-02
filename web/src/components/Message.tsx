import { createContext, useContext } from 'react'
import {
  type AgentTask,
  formatDuration,
  isFinished,
  taskName,
  teamColor,
  teammateEvent,
} from '../agents'
import { baseName, splitMentions } from '../files'
import type { MessageKey } from '../i18n'
import { Markdown } from '../markdown/Markdown'
import type { Block, Item, ModelOption } from '../protocol'
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

function ToolCard({
  block,
  t,
}: {
  block: Extract<Block, { kind: 'tool' }>
  t: (key: MessageKey) => string
}) {
  const files = useContext(FilesContext)
  const agents = useContext(AgentsContext)
  const web = useContext(WebPreviewContext)
  const path = files.open && !block.isError ? toolFilePath(block.name, block.input) : undefined
  const webUrl =
    !path && block.result && web.target && web.open
      ? firstPreviewUrl(stripAnsi(block.result), web.target)
      : undefined
  const task = agents.byToolUse?.get(block.id)
  const done = block.result !== undefined
  return (
    <details className={`toolcard${block.isError ? ' bad' : ''}`}>
      <summary>
        <span className="tname">{block.name}</span>
        <span className="tcmd">{toolSummary(block.name, block.input)}</span>
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
          {(path || webUrl) && (
            <button
              type="button"
              className="chipbtn tool-preview"
              title={webUrl}
              onClick={e => {
                e.preventDefault()
                if (path) files.open?.(path)
                else web.open?.(webUrl!)
              }}
            >
              {t('preview')}
            </button>
          )}
        </span>
        <span className={`tstat${done ? (block.isError ? ' bad' : ' ok') : ''}`}>
          {done ? (block.isError ? '✗' : '✓') : <span className="spin" aria-hidden="true" />}
        </span>
      </summary>
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
    </details>
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

export function Message({
  item,
  t,
  fallbackModel,
  models = [],
  streaming,
  sources,
}: {
  item: Item
  t: (key: MessageKey) => string
  fallbackModel?: string
  models?: ModelOption[]
  streaming: boolean
  sources?: Source[]
}) {
  const files = useContext(FilesContext)
  if (item.kind === 'user') {
    return (
      <div className="msg user">
        <span className="who">{t('you')}</span>
        <div className="bubble">
          {item.images?.map((src, i) => (
            <img key={i} className="bubble-image" src={src} alt="" />
          ))}
          <UserText text={item.text} />
        </div>
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
  return (
    <div className="msg assistant">
      <span className="who">
        Claude{label && <span className="wm"> ({label})</span>}
      </span>
      {item.blocks.map((block, i) => {
        if (!block) return null
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
          return (
            <details key={i} className="think">
              <summary>{t('thinking')}</summary>
              <div className="tbody">{block.text}</div>
            </details>
          )
        }
        return <ToolCard key={i} block={block} t={t} />
      })}
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
