import type { MessageKey } from '../i18n'
import { Markdown } from '../markdown/Markdown'
import type { Approval, ApprovalChoice, Block, Item } from '../protocol'
import { stripAnsi, toolSummary } from '../tools'

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
  return (
    <details className={`tool${block.isError ? ' tool-error' : ''}`}>
      <summary>
        <span className="tool-name">{block.name}</span>
        <span className="tool-args">{toolSummary(block.name, block.input)}</span>
      </summary>
      <div className="tool-body">
        <div className="tool-label">{t('toolInput')}</div>
        <pre>{prettyJson(block.input)}</pre>
        {block.result !== undefined && (
          <>
            <div className="tool-label">{t('toolOutput')}</div>
            <pre>{stripAnsi(block.result)}</pre>
          </>
        )}
      </div>
    </details>
  )
}

export function Message({
  item,
  t,
  fallbackModel,
  streaming,
}: {
  item: Item
  t: (key: MessageKey) => string
  fallbackModel?: string
  streaming: boolean
}) {
  if (item.kind === 'user') {
    return (
      <div className="msg msg-user">
        <div className="sender">{t('you')}</div>
        <div className="bubble">{item.text}</div>
      </div>
    )
  }
  if (item.kind === 'error') {
    return (
      <div className="msg msg-error" role="alert">
        {item.text}
      </div>
    )
  }
  const label = modelLabel(item.model ?? fallbackModel)
  return (
    <div className="msg msg-assistant">
      <div className="sender">{label ? `Claude (${label})` : 'Claude'}</div>
      {item.blocks.map((block, i) => {
        if (!block) return null
        if (block.kind === 'text') {
          return (
            <Markdown
              key={i}
              text={block.text}
              streaming={streaming && i === item.blocks.length - 1}
            />
          )
        }
        if (block.kind === 'thinking') {
          return (
            <details key={i} className="thinking">
              <summary>{t('thinking')}</summary>
              <div className="text">{block.text}</div>
            </details>
          )
        }
        return <ToolCard key={i} block={block} t={t} />
      })}
    </div>
  )
}

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
] as const

export const MODE_KEYS: Record<(typeof PERMISSION_MODES)[number], MessageKey> = {
  default: 'modeDefault',
  acceptEdits: 'modeAcceptEdits',
  plan: 'modePlan',
  auto: 'modeAuto',
  bypassPermissions: 'modeBypass',
}

export function ApprovalCard({
  approval,
  t,
  onAnswer,
}: {
  approval: Approval
  t: (key: MessageKey, vars?: Record<string, string>) => string
  onAnswer: (choice: ApprovalChoice) => void
}) {
  return (
    <div className="approval" role="dialog" aria-label={approval.toolName}>
      <div className="approval-title">
        {t('approvalTitle', { tool: approval.toolName })}
      </div>
      <div className="approval-summary">
        {toolSummary(approval.toolName, JSON.stringify(approval.input))}
      </div>
      <details>
        <summary>{t('toolInput')}</summary>
        <pre>{JSON.stringify(approval.input, null, 2)}</pre>
      </details>
      <div className="approval-actions">
        <button type="button" onClick={() => onAnswer('deny')}>
          {t('deny')}
        </button>
        {approval.suggestions.length > 0 && (
          <button type="button" onClick={() => onAnswer('always')}>
            {t('allowAlways')}
          </button>
        )}
        <button
          type="button"
          className="primary"
          onClick={() => onAnswer('allow')}
        >
          {t('allow')}
        </button>
      </div>
    </div>
  )
}

