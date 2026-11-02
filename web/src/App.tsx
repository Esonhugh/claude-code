import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import {
  createSession,
  deleteSession,
  getInfo,
  listHistory,
  listRunning,
  loadTranscript,
  openSessionSocket,
  renameSession,
} from './api'
import {
  filterCommands,
  moveSelection,
  paletteQuery,
  type SlashCommand,
} from './commands'
import { AgentsPanel, type AgentsView } from './components/Agents'
import {
  AgentsContext,
  ApprovalCard,
  FilesContext,
  MODE_KEYS,
  Message,
  modelLabel,
  PERMISSION_MODES,
} from './components/Chat'
import { Preview } from './components/Preview'
import { chatMarkdown, exportFileName } from './exportChat'
import {
  filesBase,
  formatBytes,
  IMAGE_TYPES,
  mentionPath,
  readAsDataUrl,
  uploadFile,
} from './files'
import {
  initialLang,
  type Lang,
  LANGS,
  type MessageKey,
  saveLang,
  translate,
} from './i18n'
import {
  type Approval,
  type ApprovalChoice,
  controlRequest,
  type ModelOption,
  permissionResponse,
  REQUEST_PREFIX,
  unsupportedControlResponse,
  userMessage,
} from './protocol'
import { turnSources } from './sources'
import {
  appReducer,
  groupHistory,
  type HistoryEntry,
  initialAppState,
  type SessionChat,
} from './store'

type T = (key: MessageKey, vars?: Record<string, string>) => string

const HISTORY_PAGE = 50
const MODELS_KEY = 'claude-web-models'
const COLLAPSED_KEY = 'claude-web-collapsed'
const AGENTS_OPEN_KEY = 'claude-web-agents-open'
// The Messages API rejects larger inline images; those are uploaded instead.
const INLINE_IMAGE_BYTES = 5 * 1024 * 1024

/** Images go inline as image blocks; other files are uploaded and @-mentioned. */
async function prepareContent(
  sessionId: string,
  text: string,
  files: File[],
): Promise<{ text: string; images: string[] }> {
  const images: string[] = []
  const mentions: string[] = []
  for (const file of files) {
    if (IMAGE_TYPES.has(file.type) && file.size <= INLINE_IMAGE_BYTES) {
      images.push(await readAsDataUrl(file))
    } else {
      mentions.push(mentionPath((await uploadFile(sessionId, file)).path))
    }
  }
  return { text: [text, mentions.join(' ')].filter(Boolean).join('\n\n'), images }
}

function readStored<V>(key: string, fallback: V): V {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as V) : fallback
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not persisted; fine for a per-browser convenience.
  }
}

function Composer({
  t,
  busy,
  disabled,
  placeholder,
  draft,
  setDraft,
  onSend,
  onStop,
  onFocus,
  big,
  files,
  setFiles,
  commands = [],
  hiddenCommands,
}: {
  t: T
  busy: boolean
  disabled?: boolean
  placeholder: string
  draft: string
  setDraft: (v: string) => void
  onSend: () => void
  onStop: () => void
  onFocus?: () => void
  big?: boolean
  files: File[]
  setFiles: (files: File[]) => void
  commands?: SlashCommand[]
  hiddenCommands?: string[]
}) {
  const picker = useRef<HTMLInputElement>(null)
  const paletteId = useId()
  const [selected, setSelected] = useState(0)
  // Esc closes the palette for this exact draft; typing reopens it.
  const [dismissed, setDismissed] = useState<string>()
  const query = dismissed === draft ? undefined : paletteQuery(draft)
  const matches =
    query === undefined ? [] : filterCommands(commands, query, hiddenCommands)
  const active = Math.min(selected, matches.length - 1)
  useEffect(() => {
    if (active >= 0) {
      document.getElementById(`${paletteId}-${active}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [active, paletteId])
  const pick = (command: SlashCommand) => {
    setDraft(`/${command.name} `)
    setSelected(0)
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files]
    if (!pasted.length) return
    e.preventDefault()
    setFiles([...files, ...pasted])
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length && !e.nativeEvent.isComposing) {
      const command = matches[active]!
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected(moveSelection(active, e.key === 'ArrowDown' ? 1 : -1, matches.length))
        return
      }
      // Enter on a fully typed name sends it; otherwise it completes the name.
      if (
        e.key === 'Tab' ||
        (e.key === 'Enter' && !e.shiftKey && draft !== `/${command.name}`)
      ) {
        e.preventDefault()
        pick(command)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(draft)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onSend()
    }
    if (e.key === 'Escape' && busy) onStop()
  }
  return (
    <div className={`input-card${big ? ' input-big' : ''}`}>
      {matches.length > 0 && (
        <ul className="palette" id={paletteId} role="listbox" aria-label={t('commands')}>
          {matches.map((command, i) => (
            <li
              key={command.name}
              id={`${paletteId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              // Keep focus in the textarea.
              onMouseDown={e => e.preventDefault()}
              onMouseEnter={() => setSelected(i)}
              onClick={() => pick(command)}
            >
              <span className="palette-name">
                /{command.name}
                {command.argumentHint && <small> {command.argumentHint}</small>}
              </span>
              <span className="palette-desc">{command.description}</span>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <div className="attachments">
          {files.map((file, i) => (
            <span className="attachment" key={`${file.name}-${i}`}>
              <span className="attachment-name">{file.name}</span>
              <small>{formatBytes(file.size)}</small>
              <button
                type="button"
                className="ghost"
                aria-label={t('removeAttachment', { name: file.name })}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        value={draft}
        placeholder={placeholder}
        rows={big ? 3 : 1}
        disabled={disabled}
        role="combobox"
        aria-expanded={matches.length > 0}
        aria-controls={paletteId}
        aria-autocomplete="list"
        aria-activedescendant={matches.length ? `${paletteId}-${active}` : undefined}
        onChange={e => {
          setDraft(e.target.value)
          setSelected(0)
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={onFocus}
        autoFocus={big}
      />
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label={t('attach')}
        onChange={e => {
          setFiles([...files, ...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <button
        type="button"
        className="ghost attach"
        aria-label={t('attach')}
        disabled={disabled}
        onClick={() => picker.current?.click()}
      >
        +
      </button>
      {busy ? (
        <button type="button" className="send" aria-label={t('stop')} onClick={onStop}>
          ■
        </button>
      ) : (
        <button
          type="button"
          className="send"
          aria-label={t('send')}
          disabled={disabled || (!draft.trim() && !files.length)}
          onClick={onSend}
        >
          ↑
        </button>
      )}
    </div>
  )
}

function ModeSelect({
  t,
  value,
  onChange,
}: {
  t: T
  value: string
  onChange: (mode: string) => void
}) {
  return (
    <select
      aria-label={t('permissionMode')}
      className={`mode mode-${value}`}
      value={value}
      onChange={e => onChange(e.target.value)}
    >
      {PERMISSION_MODES.map(m => (
        <option key={m} value={m}>
          {t(MODE_KEYS[m])}
        </option>
      ))}
    </select>
  )
}

function ModelSelect({
  t,
  value,
  options,
  onChange,
}: {
  t: T
  value: string | undefined
  options: ModelOption[]
  onChange: (model: string) => void
}) {
  const list =
    options.length || !value
      ? options
      : [{ value, displayName: modelLabel(value) ?? value }]
  if (!list.length) return null
  const current =
    list.find(m => m.value === value)?.value ??
    list.find(m => modelLabel(m.value) === modelLabel(value))?.value ??
    ''
  return (
    <select aria-label={t('model')} value={current} onChange={e => onChange(e.target.value)}>
      {current === '' && <option value="">{modelLabel(value) ?? t('model')}</option>}
      {list.map(m => (
        <option key={m.value} value={m.value}>
          {m.displayName}
        </option>
      ))}
    </select>
  )
}

function Sidebar({
  t,
  history,
  historyDone,
  running,
  view,
  onNew,
  onOpen,
  onRename,
  onStop,
  onMore,
}: {
  t: T
  history: HistoryEntry[]
  historyDone: boolean
  running: Record<string, boolean>
  view: string | null
  onNew: (cwd?: string) => void
  onOpen: (entry: HistoryEntry) => void
  onRename: (entry: HistoryEntry, title: string) => void
  onStop: (id: string) => void
  onMore: () => void
}) {
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    readStored(COLLAPSED_KEY, {}),
  )
  const [editing, setEditing] = useState<string | null>(null)
  const groups = groupHistory(history, filter)
  const activeCwd = history.find(h => h.id === view)?.cwd

  const toggle = (cwd: string) => {
    const next = { ...collapsed, [cwd]: !collapsed[cwd] }
    setCollapsed(next)
    writeStored(COLLAPSED_KEY, next)
  }

  return (
    <aside className="sidebar" id="sidebar">
      <button type="button" className="new-chat" onClick={() => onNew()}>
        + {t('newChat')}
      </button>
      <input
        className="search"
        type="search"
        placeholder={t('searchHistory')}
        aria-label={t('searchHistory')}
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <nav className="history" aria-label={t('history')}>
        {groups.map(group => {
          const isCollapsed = !filter && group.cwd !== activeCwd && collapsed[group.cwd]
          return (
            <section key={group.cwd} className="group">
              <div className="group-head">
                <button
                  type="button"
                  className="group-name"
                  title={group.cwd}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(group.cwd)}
                >
                  <span>{group.name || t('noFolder')}</span>
                  <small>{group.cwd}</small>
                </button>
                <button
                  type="button"
                  className="ghost group-add"
                  aria-label={t('newChatHere')}
                  title={t('newChatHere')}
                  onClick={() => onNew(group.cwd || undefined)}
                >
                  +
                </button>
              </div>
              {!isCollapsed &&
                group.entries.map(entry => (
                  <div
                    key={entry.id}
                    className={`session-row${entry.id === view ? ' active' : ''}`}
                  >
                    {editing === entry.id ? (
                      <input
                        className="rename"
                        defaultValue={entry.title}
                        autoFocus
                        aria-label={t('rename')}
                        onBlur={() => setEditing(null)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') setEditing(null)
                          if (e.key === 'Enter') {
                            const title = e.currentTarget.value.trim()
                            if (title) onRename(entry, title)
                            setEditing(null)
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="session-title"
                        onClick={() => onOpen(entry)}
                        onDoubleClick={() => setEditing(entry.id)}
                      >
                        {running[entry.id] && (
                          <span className="dot" aria-label={t('running')} />
                        )}
                        <span>{entry.title}</span>
                      </button>
                    )}
                    <span className="row-actions">
                      <button
                        type="button"
                        className="ghost"
                        aria-label={t('rename')}
                        title={t('rename')}
                        onClick={() => setEditing(entry.id)}
                      >
                        ✎
                      </button>
                      {running[entry.id] && (
                        <button
                          type="button"
                          className="ghost"
                          aria-label={t('stopSession')}
                          title={t('stopSession')}
                          onClick={() => onStop(entry.id)}
                        >
                          ■
                        </button>
                      )}
                    </span>
                  </div>
                ))}
            </section>
          )
        })}
        {!historyDone && !filter && (
          <button type="button" className="ghost more" onClick={onMore}>
            {t('loadMore')}
          </button>
        )}
      </nav>
    </aside>
  )
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialAppState)
  const [lang, setLang] = useState<Lang>(initialLang)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<Record<string, File[]>>({})
  const [preview, setPreview] = useState<{ sessionId: string; path: string }>()
  const [dragging, setDragging] = useState(false)
  const [agentsOpen, setAgentsOpenState] = useState<boolean>(() =>
    readStored(AGENTS_OPEN_KEY, false),
  )
  const [agentsView, setAgentsView] = useState<AgentsView>({ kind: 'tree' })
  const pendingRequests = useRef(new Map<string, (response: Record<string, unknown>) => void>())
  const [workspace, setWorkspace] = useState<string>()
  const [knownModels, setKnownModels] = useState<ModelOption[]>(() =>
    readStored(MODELS_KEY, []),
  )
  const sockets = useRef(new Map<string, WebSocket>())
  const requestSeq = useRef(0)
  const feedRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const stateRef = useRef(state)
  stateRef.current = state

  const t: T = useCallback(
    (key, vars) => translate(lang, key, vars),
    [lang],
  )

  const chat: SessionChat | undefined = state.view ? state.chats[state.view] : undefined
  const draftKey = state.view ?? ''
  const draft = drafts[draftKey] ?? ''
  const setDraft = (value: string) => setDrafts(d => ({ ...d, [draftKey]: value }))
  const files = attachments[draftKey] ?? []
  const setFiles = (next: File[]) => setAttachments(a => ({ ...a, [draftKey]: next }))
  const view = state.view
  const filesValue = useMemo(
    () =>
      view
        ? { open: (path: string) => setPreview({ sessionId: view, path }), base: filesBase(view) }
        : {},
    [view],
  )
  const closePreview = useCallback(() => setPreview(undefined), [])
  const setAgentsOpen = (open: boolean) => {
    setAgentsOpenState(open)
    writeStored(AGENTS_OPEN_KEY, open)
  }
  const tasks = chat?.tasks
  const agentsValue = useMemo(
    () => ({
      byToolUse: new Map(
        Object.values(tasks ?? {})
          .filter(task => task.toolUseId)
          .map(task => [task.toolUseId!, task]),
      ),
      open: (taskId: string) => {
        setPreview(undefined)
        setAgentsOpenState(true)
        writeStored(AGENTS_OPEN_KEY, true)
        setAgentsView({ kind: 'task', id: taskId })
      },
    }),
    [tasks],
  )
  useEffect(() => setAgentsView({ kind: 'tree' }), [view])
  const items = chat?.items
  const sourcesById = useMemo(
    () => turnSources(items ?? [], agentsValue.byToolUse),
    [items, agentsValue],
  )
  const chatTitle = state.history.find(h => h.id === view)?.title ?? 'Claude'
  const exportMarkdown = () => {
    if (!chat) return
    const text = chatMarkdown(
      chatTitle,
      chat.items,
      sourcesById,
      { you: t('you'), sources: t('sources') },
      chat.model,
    )
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = exportFileName(chatTitle, 'md')
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const exportPdf = () => {
    // The print dialog offers the document title as the PDF file name.
    const previous = document.title
    document.title = exportFileName(chatTitle, 'pdf').slice(0, -'.pdf'.length)
    window.print()
    document.title = previous
  }
  const runningAgents = Object.values(tasks ?? {}).filter(
    task => !['completed', 'failed', 'stopped', 'killed'].includes(task.status),
  ).length

  const refreshHistory = useCallback(async (append = false) => {
    const offset = append ? stateRef.current.history.length : 0
    try {
      const [entries, running] = await Promise.all([
        listHistory(offset, HISTORY_PAGE),
        listRunning(),
      ])
      dispatch({
        type: 'history',
        entries,
        append,
        done: entries.length < HISTORY_PAGE,
      })
      dispatch({ type: 'running', ids: running.map(r => r.id) })
    } catch {
      // The sidebar keeps what it has; the next refresh retries.
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  useEffect(() => {
    void refreshHistory()
    getInfo().then(info => {
      setWorkspace(info.workspace)
    }, () => {})
    const map = sockets.current
    return () => {
      for (const socket of map.values()) socket.close()
    }
  }, [refreshHistory])

  useEffect(() => {
    const feed = feedRef.current
    if (feed && stickToBottom.current) feed.scrollTop = feed.scrollHeight
  }, [chat?.items, state.view])

  useEffect(() => {
    if (chat?.models.length) {
      setKnownModels(chat.models)
      writeStored(MODELS_KEY, chat.models)
    }
  }, [chat?.models])

  const send = (id: string, msg: unknown) => {
    sockets.current.get(id)?.send(JSON.stringify(msg) + '\n')
  }

  const request = (id: string, prefix: string, body: Record<string, unknown>) => {
    requestSeq.current += 1
    const requestId = `${prefix}${requestSeq.current}`
    send(id, controlRequest(requestId, body))
    return requestId
  }

  /** Sends a control request and resolves with its success body. */
  const requestAsync = (id: string, prefix: string, body: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!sockets.current.has(id)) {
        reject(new Error(t('statusIdle')))
        return
      }
      const requestId = request(id, prefix, body)
      pendingRequests.current.set(requestId, response => {
        if (response.subtype === 'error') reject(new Error(String(response.error ?? 'error')))
        else resolve((response.response ?? {}) as Record<string, unknown>)
      })
    })

  const stopTask = (id: string, taskId: string) =>
    request(id, REQUEST_PREFIX.stopTask, { subtype: 'stop_task', task_id: taskId })

  const sendToTask = async (id: string, taskId: string, text: string): Promise<string> => {
    const body = await requestAsync(id, REQUEST_PREFIX.taskMessage, {
      subtype: 'send_task_message',
      task_id: taskId,
      text,
    })
    const delivery = String(body.delivery ?? '')
    return delivery === 'queued' || delivery === 'injected' || delivery === 'resumed'
      ? t(`delivery_${delivery}` as MessageKey)
      : delivery
  }

  const attach = async (id: string): Promise<void> => {
    const socket = await openSessionSocket(id, raw => {
      const msg = raw as { type?: string; response?: Record<string, unknown> }
      const requestId = msg.type === 'control_response' ? msg.response?.request_id : undefined
      const pending = typeof requestId === 'string' && pendingRequests.current.get(requestId)
      if (pending) {
        pendingRequests.current.delete(requestId as string)
        pending(msg.response!)
      }
      dispatch({ type: 'chat', id, action: { type: 'message', raw } })
      const reply = unsupportedControlResponse(raw)
      if (reply) socket.send(JSON.stringify(reply) + '\n')
      if ((raw as { type?: string }).type === 'result') {
        request(id, REQUEST_PREFIX.context, { subtype: 'get_context_usage' })
        void refreshHistory()
      }
    })
    socket.addEventListener('close', () => {
      if (sockets.current.get(id) !== socket) return
      sockets.current.delete(id)
      dispatch({ type: 'mode', id, mode: 'readonly' })
      dispatch({ type: 'chat', id, action: { type: 'error', text: t('sessionEnded') } })
      void refreshHistory()
    })
    sockets.current.set(id, socket)
    dispatch({ type: 'mode', id, mode: 'live' })
    request(id, REQUEST_PREFIX.initialize, { subtype: 'initialize' })
  }

  const loadInto = async (id: string, before?: number) => {
    const page = await loadTranscript(id, before)
    dispatch({
      type: 'loaded',
      id,
      messages: page.messages,
      start: page.start,
      workDir: page.cwd,
      prepend: before !== undefined,
    })
  }

  const openSession = async (entry: HistoryEntry) => {
    stickToBottom.current = true
    dispatch({ type: 'view', id: entry.id })
    if (stateRef.current.chats[entry.id]) return
    dispatch({ type: 'mode', id: entry.id, mode: 'readonly' })
    try {
      await loadInto(entry.id)
    } catch (err) {
      dispatch({
        type: 'chat',
        id: entry.id,
        action: { type: 'error', text: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    // A session still running with no tab attached is picked up directly.
    const running = await listRunning().catch(() => [])
    const live = running.find(r => r.id === entry.id)
    if (live?.attached) dispatch({ type: 'mode', id: entry.id, mode: 'elsewhere' })
    else if (live) await attach(entry.id).catch(() => {})
  }

  /** Starts the process for a read-only transcript (prewarm on focus). */
  const resume = async (id: string): Promise<boolean> => {
    const current = stateRef.current.chats[id]
    if (!current || current.mode === 'live') return true
    if (current.mode === 'connecting' || current.mode === 'elsewhere') return false
    dispatch({ type: 'mode', id, mode: 'connecting' })
    try {
      const running = await listRunning()
      if (running.find(r => r.id === id)?.attached) {
        dispatch({ type: 'mode', id, mode: 'elsewhere' })
        return false
      }
      const entry = stateRef.current.history.find(h => h.id === id)
      await createSession({
        resume: id,
        cwd: current.workDir ?? entry?.cwd,
        ...(current.permissionMode && { permission_mode: current.permissionMode }),
      })
      await attach(id)
      return true
    } catch (err) {
      dispatch({ type: 'mode', id, mode: 'readonly' })
      dispatch({
        type: 'chat',
        id,
        action: {
          type: 'local',
          patch: {
            notice: t('resumeFailed', {
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        },
      })
      return false
    }
  }

  const sendInChat = async () => {
    const id = state.view
    const text = draft.trim()
    const pending = files
    if (!id || !chat || (!text && !pending.length) || chat.busy) return
    if (chat.mode !== 'live' && !(await resume(id))) return
    let content: { text: string; images: string[] }
    try {
      content = await prepareContent(id, text, pending)
    } catch (err) {
      dispatch({
        type: 'chat',
        id,
        action: {
          type: 'local',
          patch: { notice: t('uploadFailed', { error: err instanceof Error ? err.message : String(err) }) },
        },
      })
      return
    }
    setDrafts(d => ({ ...d, [id]: '' }))
    setAttachments(a => ({ ...a, [id]: [] }))
    stickToBottom.current = true
    dispatch({ type: 'chat', id, action: { type: 'user', ...content } })
    send(id, userMessage(content.text, content.images))
  }

  const startChat = async () => {
    const text = (drafts[''] ?? '').trim()
    const pending = attachments[''] ?? []
    if (!text && !pending.length) return
    const { cwd, mode, model } = state.start
    try {
      const created = await createSession({
        ...(cwd && { cwd }),
        ...(mode !== 'default' && { permission_mode: mode }),
        ...(model && { model }),
      })
      const id = created.session_id
      const content = await prepareContent(id, text, pending)
      setDrafts(d => ({ ...d, '': '' }))
      setAttachments(a => ({ ...a, '': [] }))
      stickToBottom.current = true
      dispatch({
        type: 'created',
        id,
        workDir: created.work_dir,
        title: (text || pending[0]!.name).split('\n')[0]!.slice(0, 80),
        start: state.start,
      })
      await attach(id)
      dispatch({ type: 'chat', id, action: { type: 'user', ...content } })
      send(id, userMessage(content.text, content.images))
    } catch (err) {
      setStartError(
        t('connectFailed', { error: err instanceof Error ? err.message : String(err) }),
      )
    }
  }
  const [startError, setStartError] = useState<string>()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const menuRef = useRef<HTMLButtonElement>(null)
  const panelOpen = !!((preview && preview.sessionId === view) || (agentsOpen && chat))
  const panelOpener = useRef<HTMLElement | null>(null)

  // On narrow screens both side panels are drawers: move focus into them when
  // they open, close the sidebar on Esc (the panels handle their own), and
  // give focus back to whatever opened them once they close.
  useEffect(() => {
    if (!sidebarOpen) return
    document.querySelector<HTMLElement>('.sidebar .new-chat')?.focus()
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const active = document.activeElement
      if (!active || active === document.body || active.closest('.sidebar')) {
        menuRef.current?.focus()
      }
    }
  }, [sidebarOpen])
  useEffect(() => {
    if (!panelOpen) return
    panelOpener.current = document.activeElement as HTMLElement | null
    if (window.matchMedia('(max-width: 760px)').matches) {
      document.querySelector<HTMLElement>('.preview button')?.focus()
    }
    return () => {
      const active = document.activeElement
      if (!active || active === document.body) panelOpener.current?.focus()
    }
  }, [panelOpen])
  const closePanel = () => {
    if (preview && preview.sessionId === view) closePreview()
    else setAgentsOpen(false)
  }

  const stop = (id: string) => request(id, REQUEST_PREFIX.interrupt, { subtype: 'interrupt' })

  const answer = (id: string, approval: Approval, choice: ApprovalChoice) => {
    send(id, permissionResponse(approval, choice))
    dispatch({ type: 'chat', id, action: { type: 'answered', requestId: approval.requestId } })
  }

  const changeMode = (id: string, mode: string) => {
    if (sockets.current.has(id)) {
      request(id, REQUEST_PREFIX.mode, { subtype: 'set_permission_mode', mode })
    } else {
      dispatch({ type: 'chat', id, action: { type: 'local', patch: { permissionMode: mode } } })
    }
  }

  const changeModel = (id: string, model: string) => {
    dispatch({ type: 'chat', id, action: { type: 'local', patch: { model, notice: undefined } } })
    if (sockets.current.has(id)) {
      request(id, REQUEST_PREFIX.model, { subtype: 'set_model', model })
    }
  }

  const stopSession = async (id: string) => {
    const socket = sockets.current.get(id)
    sockets.current.delete(id)
    socket?.close()
    await deleteSession(id).catch(() => {})
    if (stateRef.current.chats[id]) dispatch({ type: 'mode', id, mode: 'readonly' })
    void refreshHistory()
  }

  const rename = async (entry: HistoryEntry, title: string) => {
    try {
      await renameSession(entry.id, title)
      dispatch({ type: 'renamed', id: entry.id, title })
    } catch {
      // A session that has not written a transcript yet cannot be renamed.
    }
  }

  const newChat = (cwd?: string) => {
    setStartError(undefined)
    dispatch({ type: 'startOptions', patch: { cwd } })
    dispatch({ type: 'view', id: null })
  }

  const usage = chat
    ? [
        chat.contextPercent !== undefined &&
          t('contextUsed', { percent: String(Math.round(chat.contextPercent)) }),
        chat.costUsd !== undefined &&
          new Intl.NumberFormat(lang, {
            style: 'currency',
            currency: 'USD',
            maximumFractionDigits: 2,
          }).format(chat.costUsd),
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  const recentDirs = [
    ...new Set(
      [workspace, ...state.history.map(h => h.cwd)].filter((d): d is string => !!d),
    ),
  ].slice(0, 12)

  return (
    <div
      className={`app${sidebarOpen ? ' sidebar-open' : ''}${panelOpen ? ' previewing' : ''}`}
    >
      <div
        className="scrim"
        aria-hidden="true"
        onClick={() => (sidebarOpen ? setSidebarOpen(false) : closePanel())}
      />
      <Sidebar
        t={t}
        history={state.history}
        historyDone={state.historyDone}
        running={state.running}
        view={state.view}
        onNew={cwd => {
          setSidebarOpen(false)
          newChat(cwd)
        }}
        onOpen={entry => {
          setSidebarOpen(false)
          void openSession(entry)
        }}
        onRename={(entry, title) => void rename(entry, title)}
        onStop={id => void stopSession(id)}
        onMore={() => void refreshHistory(true)}
      />
      <div
        className={`main${dragging ? ' dragging' : ''}`}
        onDragOver={(e: DragEvent) => {
          if (!e.dataTransfer.types.includes('Files') || chat?.mode === 'elsewhere') return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e: DragEvent) => {
          setDragging(false)
          if (!e.dataTransfer.files.length || chat?.mode === 'elsewhere') return
          e.preventDefault()
          setFiles([...files, ...e.dataTransfer.files])
        }}
      >
        <header className="topbar">
          <button
            type="button"
            ref={menuRef}
            className="ghost menu"
            aria-label={t('menu')}
            aria-controls="sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          {chat && (
            <>
              <span className={`status status-${chat.mode}`} role="status">
                {t(
                  chat.mode === 'live'
                    ? 'statusLive'
                    : chat.mode === 'elsewhere'
                      ? 'statusElsewhere'
                      : chat.mode === 'connecting'
                        ? 'statusConnecting'
                        : 'statusIdle',
                )}
              </span>
              <span className="cwd">{chat.cwd ?? chat.workDir}</span>
            </>
          )}
          {!chat && <span className="cwd" />}
          {chat && chat.items.length > 0 && (
            <details className="export-menu">
              <summary className="ghost">{t('export')}</summary>
              <div className="export-options">
                {(
                  [
                    ['exportMarkdown', exportMarkdown],
                    ['exportPdf', exportPdf],
                  ] as const
                ).map(([key, run]) => (
                  <button
                    type="button"
                    className="ghost"
                    key={key}
                    onClick={e => {
                      e.currentTarget.closest('details')?.removeAttribute('open')
                      run()
                    }}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            </details>
          )}
          {chat && (
            <button
              type="button"
              className={`ghost agents-toggle${agentsOpen ? ' active' : ''}`}
              aria-expanded={agentsOpen}
              onClick={() => {
                setAgentsOpen(!agentsOpen)
                if (!agentsOpen) setPreview(undefined)
              }}
            >
              {t('agents')}
              {runningAgents > 0 && <span className="badge">{runningAgents}</span>}
            </button>
          )}
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

        {!chat ? (
          <main className="start">
            <div className="col">
              <h1 className="greeting">{t('greeting')}</h1>
              <Composer
                t={t}
                big
                busy={false}
                placeholder={t('placeholder')}
                draft={drafts[''] ?? ''}
                setDraft={v => setDrafts(d => ({ ...d, '': v }))}
                onSend={() => void startChat()}
                onStop={() => {}}
                files={files}
                setFiles={setFiles}
              />
              {startError && (
                <div className="notice" role="alert">
                  {startError}
                </div>
              )}
              <div className="start-options">
                <select
                  aria-label={t('folder')}
                  value={state.start.cwd ?? workspace ?? ''}
                  onChange={e => {
                    if (e.target.value === '__other__') {
                      const path = window.prompt(t('folderPrompt'))?.trim()
                      if (path) dispatch({ type: 'startOptions', patch: { cwd: path } })
                      return
                    }
                    dispatch({ type: 'startOptions', patch: { cwd: e.target.value || undefined } })
                  }}
                >
                  {[...new Set([...(state.start.cwd ? [state.start.cwd] : []), ...recentDirs])].map(
                    dir => (
                      <option key={dir} value={dir}>
                        {dir === workspace ? `${t('workspace')} · ${dir}` : dir}
                      </option>
                    ),
                  )}
                  <option value="__other__">{t('otherFolder')}</option>
                </select>
                <span className="spacer" />
                <ModeSelect
                  t={t}
                  value={state.start.mode}
                  onChange={mode => dispatch({ type: 'startOptions', patch: { mode } })}
                />
                <ModelSelect
                  t={t}
                  value={state.start.model}
                  options={knownModels}
                  onChange={model => dispatch({ type: 'startOptions', patch: { model } })}
                />
              </div>
              <div className="recent">
                {state.history
                  .filter(h => (h.cwd ?? '') === (state.start.cwd ?? workspace ?? ''))
                  .slice(0, 3)
                  .map(entry => (
                    <button
                      type="button"
                      key={entry.id}
                      className="recent-card"
                      onClick={() => void openSession(entry)}
                    >
                      <span className="recent-title">{entry.title}</span>
                      <small>
                        {new Intl.DateTimeFormat(lang, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(entry.lastModified)}
                      </small>
                    </button>
                  ))}
              </div>
            </div>
          </main>
        ) : (
          <AgentsContext.Provider value={agentsValue}>
          <FilesContext.Provider value={filesValue}>
            <main
              className="feed"
              ref={feedRef}
              aria-busy={chat.busy}
              onScroll={e => {
                const el = e.currentTarget
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              }}
            >
              <div className="col">
                {chat.start > 0 && (
                  <button
                    type="button"
                    className="ghost more"
                    onClick={() => state.view && void loadInto(state.view, chat.start)}
                  >
                    {t('loadEarlier')}
                  </button>
                )}
                {chat.items.map(item => (
                  <Message
                    key={item.id}
                    item={item}
                    t={t}
                    fallbackModel={chat.model}
                    streaming={chat.busy && item.id === chat.streamingId}
                    sources={sourcesById.get(item.id)}
                  />
                ))}
              </div>
            </main>
            <footer className="composer">
              <div className="col">
                {chat.approvals[0] && state.view && (
                  <ApprovalCard
                    approval={chat.approvals[0]}
                    t={t}
                    onAnswer={choice => answer(state.view!, chat.approvals[0]!, choice)}
                  />
                )}
                {chat.mode === 'elsewhere' && (
                  <div className="notice" role="status">
                    {t('openElsewhere')}
                  </div>
                )}
                {chat.notice && (
                  <div className="notice" role="status">
                    {chat.notice}
                  </div>
                )}
                <Composer
                  t={t}
                  busy={chat.busy}
                  disabled={chat.mode === 'elsewhere'}
                  placeholder={t('placeholder')}
                  draft={draft}
                  setDraft={setDraft}
                  onSend={() => void sendInChat()}
                  onStop={() => state.view && stop(state.view)}
                  onFocus={() => state.view && chat.mode === 'readonly' && void resume(state.view)}
                  files={files}
                  setFiles={setFiles}
                  commands={chat.commands}
                  hiddenCommands={chat.terminalCommands}
                />
                <div className="composer-footer">
                  <ModeSelect
                    t={t}
                    value={chat.permissionMode ?? 'default'}
                    onChange={mode => state.view && changeMode(state.view, mode)}
                  />
                  <span className="usage">{usage}</span>
                  <ModelSelect
                    t={t}
                    value={chat.model}
                    options={chat.models.length ? chat.models : knownModels}
                    onChange={model => state.view && changeModel(state.view, model)}
                  />
                </div>
              </div>
            </footer>
          </FilesContext.Provider>
          </AgentsContext.Provider>
        )}
      </div>
      {preview && preview.sessionId === view ? (
        <Preview
          sessionId={preview.sessionId}
          path={preview.path}
          t={t}
          onClose={closePreview}
        />
      ) : (
        agentsOpen &&
        chat &&
        view && (
          <AgentsPanel
            sessionId={view}
            tasks={chat.tasks}
            busy={chat.busy}
            view={agentsView}
            setView={setAgentsView}
            onStop={taskId => stopTask(view, taskId)}
            onSend={(taskId, text) => sendToTask(view, taskId, text)}
            onClose={() => setAgentsOpen(false)}
            t={t}
          />
        )
      )}
    </div>
  )
}
