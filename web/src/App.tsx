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
import {
  addError,
  addUserMessage,
  type Approval,
  type Block,
  type ChatState,
  initialState,
  interruptRequest,
  type Item,
  permissionResponse,
  reduce,
  removeApproval,
  unsupportedControlResponse,
  userMessage,
} from './protocol'

type Action =
  | { type: 'message'; raw: unknown }
  | { type: 'user'; text: string }
  | { type: 'error'; text: string }
  | { type: 'answered'; requestId: string }
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
        <span className="tool-args">{block.input}</span>
      </summary>
      <div className="tool-body">
        <div className="tool-label">{t('toolInput')}</div>
        <pre>{prettyJson(block.input)}</pre>
        {block.result !== undefined && (
          <>
            <div className="tool-label">{t('toolOutput')}</div>
            <pre>{block.result}</pre>
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
}: {
  item: Item
  t: (key: MessageKey) => string
  fallbackModel?: string
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
            <div key={i} className="text">
              {block.text}
            </div>
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

export function App() {
  const [state, dispatch] = useReducer(chatReducer, initialState)
  const [lang, setLang] = useState<Lang>(initialLang)
  const [draft, setDraft] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const sessionRef = useRef<string | null>(null)
  const requestSeq = useRef(0)
  const feedRef = useRef<HTMLDivElement>(null)

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
    if (feed) feed.scrollTop = feed.scrollHeight
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

  const ensureSocket = async (): Promise<WebSocket> => {
    const current = socketRef.current
    if (current && current.readyState <= WebSocket.OPEN) return current
    const { session_id: sessionId } = await createSession({})
    sessionRef.current = sessionId
    const socket = await openSessionSocket(sessionId, raw => {
      dispatch({ type: 'message', raw })
      const reply = unsupportedControlResponse(raw)
      if (reply) socket.send(JSON.stringify(reply) + '\n')
    })
    socket.addEventListener('close', () => {
      if (socketRef.current !== socket) return
      socketRef.current = null
      sessionRef.current = null
      dispatch({ type: 'error', text: t('sessionEnded') })
    })
    socketRef.current = socket
    return socket
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || state.busy) return
    setDraft('')
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

  const stop = () => {
    requestSeq.current += 1
    sendRaw(interruptRequest(`web-interrupt-${requestSeq.current}`))
  }

  const answer = (approval: Approval, allow: boolean) => {
    sendRaw(permissionResponse(approval, allow))
    dispatch({ type: 'answered', requestId: approval.requestId })
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
  }

  const approval = state.approvals[0]

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
      <main className="feed" ref={feedRef}>
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
            />
          ))}
        </div>
      </main>
      <footer className="composer">
        <div className="col">
          {approval && (
            <div className="approval" role="dialog">
              <div className="approval-title">
                {t('approvalTitle', { tool: approval.toolName })}
              </div>
              <pre>{JSON.stringify(approval.input, null, 2)}</pre>
              <div className="approval-actions">
                <button type="button" onClick={() => answer(approval, false)}>
                  {t('deny')}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => answer(approval, true)}
                >
                  {t('allow')}
                </button>
              </div>
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
        </div>
      </footer>
    </div>
  )
}
