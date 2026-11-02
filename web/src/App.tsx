import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react'
import { createSession, deleteSession, openSessionSocket } from './api'
import {
  initialLang,
  type Lang,
  LANGS,
  type MessageKey,
  saveLang,
  translate,
} from './i18n'
import { Markdown } from './markdown/Markdown'
import {
  addError,
  addUserMessage,
  type Approval,
  type ApprovalChoice,
  type Block,
  type ChatState,
  controlRequest,
  initialState,
  type Item,
  permissionResponse,
  reduce,
  removeApproval,
  REQUEST_PREFIX,
  setLocal,
  unsupportedControlResponse,
  userMessage,
} from './protocol'
import { toolSummary, stripAnsi } from './tools'

type Action =
  | { type: 'message'; raw: unknown }
  | { type: 'user'; text: string }
  | { type: 'error'; text: string }
  | { type: 'answered'; requestId: string }
  | { type: 'local'; patch: Parameters<typeof setLocal>[1] }
  | { type: 'reset' }

function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'message':
      return reduce(state, action.raw)
    case 'user':
      return addUserMessage(state, action.text)
    case 'error':
      return addError(state, action.text)
    case 'answered':
      return removeApproval(state, action.requestId)
    case 'local':
      return setLocal(state, action.patch)
    case 'reset':
      return initialState
  }
}

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

function Message({
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

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
] as const

const MODE_KEYS: Record<(typeof PERMISSION_MODES)[number], MessageKey> = {
  default: 'modeDefault',
  acceptEdits: 'modeAcceptEdits',
  plan: 'modePlan',
  auto: 'modeAuto',
  bypassPermissions: 'modeBypass',
}

function ApprovalCard({
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

export function App() {
  const [state, dispatch] = useReducer(chatReducer, initialState)
  const [lang, setLang] = useState<Lang>(initialLang)
  const [draft, setDraft] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const sessionRef = useRef<string | null>(null)
  const requestSeq = useRef(0)
  const feedRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string>) =>
      translate(lang, key, vars),
    [lang],
  )

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    const feed = feedRef.current
    if (feed && stickToBottom.current) feed.scrollTop = feed.scrollHeight
  }, [state.items])

  useEffect(
    () => () => {
      socketRef.current?.close()
    },
    [],
  )

  const sendRaw = (msg: unknown) => {
    socketRef.current?.send(JSON.stringify(msg) + '\n')
  }

  const request = (prefix: string, body: Record<string, unknown>) => {
    requestSeq.current += 1
    sendRaw(controlRequest(`${prefix}${requestSeq.current}`, body))
  }

  const ensureSocket = async (): Promise<WebSocket> => {
    const current = socketRef.current
    if (current && current.readyState <= WebSocket.OPEN) return current
    const { session_id: sessionId } = await createSession({
      ...(state.permissionMode && { permission_mode: state.permissionMode }),
      ...(state.model && { model: state.model }),
    })
    sessionRef.current = sessionId
    const socket = await openSessionSocket(sessionId, raw => {
      dispatch({ type: 'message', raw })
      const reply = unsupportedControlResponse(raw)
      if (reply) socket.send(JSON.stringify(reply) + '\n')
      if ((raw as { type?: string }).type === 'result') {
        requestSeq.current += 1
        socket.send(
          JSON.stringify(
            controlRequest(`${REQUEST_PREFIX.context}${requestSeq.current}`, {
              subtype: 'get_context_usage',
            }),
          ) + '\n',
        )
      }
    })
    socket.addEventListener('close', () => {
      if (socketRef.current !== socket) return
      socketRef.current = null
      sessionRef.current = null
      dispatch({ type: 'error', text: t('sessionEnded') })
    })
    socketRef.current = socket
    request(REQUEST_PREFIX.initialize, { subtype: 'initialize' })
    return socket
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || state.busy) return
    setDraft('')
    stickToBottom.current = true
    dispatch({ type: 'user', text })
    try {
      const socket = await ensureSocket()
      socket.send(JSON.stringify(userMessage(text)) + '\n')
    } catch (err) {
      dispatch({
        type: 'error',
        text: t('connectFailed', {
          error: err instanceof Error ? err.message : String(err),
        }),
      })
    }
  }

  const stop = () => request(REQUEST_PREFIX.interrupt, { subtype: 'interrupt' })

  const answer = (approval: Approval, choice: ApprovalChoice) => {
    sendRaw(permissionResponse(approval, choice))
    dispatch({ type: 'answered', requestId: approval.requestId })
  }

  const changeMode = (mode: string) => {
    if (socketRef.current) {
      request(REQUEST_PREFIX.mode, { subtype: 'set_permission_mode', mode })
    } else {
      dispatch({ type: 'local', patch: { permissionMode: mode } })
    }
  }

  const changeModel = (model: string) => {
    dispatch({ type: 'local', patch: { model, notice: undefined } })
    if (socketRef.current) {
      request(REQUEST_PREFIX.model, { subtype: 'set_model', model })
    }
  }

  const newChat = () => {
    const socket = socketRef.current
    const sessionId = sessionRef.current
    socketRef.current = null
    sessionRef.current = null
    socket?.close()
    if (sessionId) void deleteSession(sessionId)
    dispatch({ type: 'reset' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
    if (e.key === 'Escape' && state.busy) stop()
  }

  const approval = state.approvals[0]
  const mode = state.permissionMode ?? 'default'
  const modelOptions = state.models.length
    ? state.models
    : state.model
      ? [{ value: state.model, displayName: modelLabel(state.model) ?? state.model }]
      : []
  const currentModel =
    modelOptions.find(m => m.value === state.model)?.value ??
    modelOptions.find(m => modelLabel(m.value) === modelLabel(state.model))
      ?.value ??
    ''
  const usage = [
    state.contextPercent !== undefined &&
      t('contextUsed', { percent: String(Math.round(state.contextPercent)) }),
    state.costUsd !== undefined &&
      new Intl.NumberFormat(lang, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      }).format(state.costUsd),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="ghost" onClick={newChat}>
          + {t('newChat')}
        </button>
        <span className="cwd">{state.cwd}</span>
        <select
          aria-label={t('language')}
          value={lang}
          onChange={e => {
            const next = e.target.value as Lang
            setLang(next)
            saveLang(next)
          }}
        >
          {LANGS.map(l => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </header>
      <main
        className="feed"
        ref={feedRef}
        onScroll={e => {
          const el = e.currentTarget
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <div className="col">
          {state.items.length === 0 && (
            <h1 className="greeting">{t('greeting')}</h1>
          )}
          {state.items.map(item => (
            <Message
              key={item.id}
              item={item}
              t={t}
              fallbackModel={state.model}
              streaming={state.busy && item.id === state.streamingId}
            />
          ))}
        </div>
      </main>
      <footer className="composer">
        <div className="col">
          {approval && (
            <ApprovalCard
              approval={approval}
              t={t}
              onAnswer={choice => answer(approval, choice)}
            />
          )}
          {state.notice && (
            <div className="notice" role="status">
              {state.notice}
            </div>
          )}
          <div className="input-card">
            <textarea
              value={draft}
              placeholder={t('placeholder')}
              rows={1}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            {state.busy ? (
              <button
                type="button"
                className="send"
                aria-label={t('stop')}
                onClick={stop}
              >
                ■
              </button>
            ) : (
              <button
                type="button"
                className="send"
                aria-label={t('send')}
                disabled={!draft.trim()}
                onClick={() => void send()}
              >
                ↑
              </button>
            )}
          </div>
          <div className="composer-footer">
            <select
              aria-label={t('permissionMode')}
              className={`mode mode-${mode}`}
              value={mode}
              onChange={e => changeMode(e.target.value)}
            >
              {PERMISSION_MODES.map(m => (
                <option key={m} value={m}>
                  {t(MODE_KEYS[m])}
                </option>
              ))}
            </select>
            <span className="usage">{usage}</span>
            {modelOptions.length > 0 && (
              <select
                aria-label={t('model')}
                value={currentModel}
                onChange={e => changeModel(e.target.value)}
              >
                {currentModel === '' && <option value="">{modelLabel(state.model) ?? t('model')}</option>}
                {modelOptions.map(m => (
                  <option key={m.value} value={m.value}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}
