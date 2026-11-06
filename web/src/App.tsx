import { type CSSProperties, type DragEvent, Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  type AuthProvider,
  createSession,
  forkSession,
  getInfo,
  getSettings as getWebSettings,
  getUsage,
  listProjects,
  listRunning,
  listWorkspaceFiles,
  loadSidebar,
  loadModels,
  loadTranscript,
  ApiError,
  NeedsTrustError,
  openCoordinator,
  openSessionSocket,
  patchProject,
  patchSettings,
  type Project,
  type ProjectTask,
  type Usage,
  type Daybreak,
  type WebSettings,
} from './api'
import { buildTeam, canChat, isFinished, taskName } from './agents'
import { AccountCard, ApiKeyDialog, LoginGate, useAccount } from './components/Account'
import { type AgentsView, agentTasks } from './components/Agents'
import { AskDock, ChatComposer, chatTools, ContextChip, GoalMenu, type MentionTarget, Pins } from './components/Composer'
import { AppDialog, type Palette, type Theme } from './components/Dialogs'
import type { ContextUsage } from './components/Settings'
import { AgentsContext, ChatContext, FilesContext, joinTurns, Message, QuoteContext, QuoteOnSelect, replyPrompt, TeamBar } from './components/Message'
import { Preview } from './components/Preview'
import { ProjectDialog } from './components/ProjectDialog'
import { ProjectView } from './components/ProjectView'
import { type DialogKind, Sidebar, type SidebarProject } from './components/Sidebar'
import { SidePanel, type SideTab } from './components/SidePanel'
import { StartPage } from './components/StartPage'
import { ColumnDrag, type Columns, columnVars } from './components/ColumnDrag'
import { FootMenu, followScroll, formatElapsed, readStored, type T, writeStored } from './components/ui'
import { WebPreview } from './components/WebPreview'
import { chatMarkdown, exportFileName } from './exportChat'
import { dataUrlFile, filesBase, IMAGE_TYPES, mentionPath, readAsDataUrl, sessionFiles, setHome, tilde, uploadFile } from './files'
import { initialLang, type Lang, saveLang, translate } from './i18n'
import {
  type Approval,
  type ApprovalChoice,
  controlRequest,
  currentTodos,
  type ModelOption,
  newUuid,
  permissionResponse,
  REQUEST_PREFIX,
  type SessionEnv,
  type TaskNote,
  type ChatState,
  taskListTodos,
  teamName,
  type Todo,
  unsupportedControlResponse,
  userMessage,
  usesTaskList,
} from './protocol'
import { agentInputs, messageTarget, notesByItem, taskNoteText } from './projects'
import { turnSources } from './sources'
import { appReducer, type HistoryEntry, initialAppState, type SessionChat } from './store'
import { nativeCommand, type SlashCommand } from './commands'
import { previewTarget, WebPreviewContext } from './webPreview'

const HISTORY_PAGE = 200
const MODELS_KEY = 'claude-web-models'
const COMMANDS_KEY = 'claude-web-commands'
const COLUMNS_KEY = 'claude-web-columns'
const ENV_KEY = 'claude-web-env'
const THEME_KEY = 'claude-web-theme'
const PALETTE_KEY = 'claude-web-palette'
const DEFAULT_UI_NAME = 'EsonClaw'
const VERBS = ['Cogitating', 'Pondering', 'Brewing', 'Crunching']
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽']
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

const isNarrow = (px: number) => window.matchMedia(`(max-width: ${px}px)`).matches

/** `✻ Cogitating… 12s  esc 中断` while a turn runs. */
function StatusLine({ t, since, retry, onStop }: { t: T; since: number; retry?: ChatState['retry']; onStop: () => void }) {
  const [tick, setTick] = useState(0)
  const verb = useMemo(() => VERBS[Math.floor(Math.random() * VERBS.length)], [since])
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 120)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="status-line" role="status">
      <span className="glyph">{GLYPHS[tick % GLYPHS.length]}</span>
      <span className="verb shimmer">{verb}…</span>
      <span className="mono">{formatElapsed(Date.now() - since)}</span>
      {retry && (
        // As the TUI's spinner row: the request failed and is tried again.
        <span className="retry">
          {t('apiRetry', {
            status: retry.status ? ` ${retry.status}` : '',
            s: String(Math.ceil(Math.max(0, retry.delayMs - (Date.now() - retry.at)) / 1000)),
            n: String(retry.attempt),
            max: String(retry.max),
          })}
        </span>
      )}
      <button type="button" onClick={onStop}>
        {t('escInterrupt')}
      </button>
    </div>
  )
}

/** Seconds since the current turn started; ticks while busy. */
function useTurnStart(busy: boolean | undefined, view: string | null): number | undefined {
  const [since, setSince] = useState<number>()
  const [, setTick] = useState(0)
  useEffect(() => setSince(busy ? Date.now() : undefined), [busy, view])
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [busy])
  return since
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialAppState)
  const [lang, setLangState] = useState<Lang>(initialLang)
  const [theme, setThemeState] = useState<Theme>(() => readStored(THEME_KEY, 'system'))
  const [palette, setPaletteState] = useState<Palette>(() => readStored(PALETTE_KEY, 'clay'))
  const [columns, setColumnsState] = useState<Columns>(() => readStored(COLUMNS_KEY, {}))
  const setColumns = (next: Columns) => {
    setColumnsState(next)
    writeStored(COLUMNS_KEY, next)
  }
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [quotes, setQuotes] = useState<Record<string, string>>({})
  // Per session: the agents its box's next message goes to, picked with `@`.
  const [agentTargets, setAgentTargets] = useState<Record<string, MentionTarget[]>>({})
  const [attachments, setAttachments] = useState<Record<string, File[]>>({})
  const [preview, setPreview] = useState<
    | { sessionId: string; path: string; image?: { src: string; target: string } }
    | { sessionId: string; url: string }
  >()
  const [info, setInfo] = useState<{ workspace?: string; tempRoot?: string; previewOrigins: string[]; version?: string }>({
    previewOrigins: [],
  })
  const [dragging, setDragging] = useState(false)
  const [sideTab, setSideTab] = useState<SideTab>('status')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [agentsView, setAgentsView] = useState<AgentsView>({ kind: 'tree' })
  const [workflowId, setWorkflowId] = useState<string>()
  const [dialog, setDialog] = useState<DialogKind>()
  const [settingsTab, setSettingsTab] = useState<'general' | 'usage' | 'features'>()
  const [startError, setStartError] = useState<string>()
  const [trustDir, setTrustDir] = useState<string>()
  const [rewindTarget, setRewindTarget] = useState<string>()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [keyDialog, setKeyDialog] = useState<AuthProvider>()
  const [webSettings, setWebSettings] = useState<WebSettings>()
  const [projects, setProjects] = useState<Project[]>([])
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  // The project shown in place of the chat; its coordinator is `state.view`.
  const [projectId, setProjectId] = useState<string>()
  const [projectDialog, setProjectDialog] = useState<'new' | Project>()
  const pendingRequests = useRef(new Map<string, { id: string; settle: (response: Record<string, unknown>) => void }>())
  // The last session's models, with the provider they came from: another provider's list is stale.
  const [knownModels, setKnownModels] = useState<{ provider?: string; models: ModelOption[] }>(() => {
    const stored = readStored<unknown>(MODELS_KEY, [])
    return Array.isArray(stored) ? { models: stored as ModelOption[] } : (stored as { provider?: string; models: ModelOption[] })
  })
  const [knownCommands, setKnownCommands] = useState<SlashCommand[]>(() => readStored(COMMANDS_KEY, []))
  const [knownEnv, setKnownEnv] = useState<SessionEnv>(() => readStored(ENV_KEY, {}))
  const sockets = useRef(new Map<string, WebSocket>())
  const requestSeq = useRef(0)
  const feedRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  const stickToBottom = useRef(true)
  const feedTop = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  const t: T = useCallback((key, vars) => translate(lang, key, vars), [lang])
  const account = useAccount(t)
  const signedOut = !!account.account && !account.account.kind
  const setLang = (next: Lang) => {
    setLangState(next)
    saveLang(next)
  }
  const setTheme = (next: Theme) => {
    setThemeState(next)
    writeStored(THEME_KEY, next)
  }
  const setPalette = (next: Palette) => {
    setPaletteState(next)
    writeStored(PALETTE_KEY, next)
  }

  const chat: SessionChat | undefined = state.view ? state.chats[state.view] : undefined
  const project = projects.find(p => p.id === projectId)
  const inProject = !!project && !!chat && project.coordinator_session_id === state.view
  const view = state.view
  const draftKey = view ?? ''
  const draft = drafts[draftKey] ?? ''
  const setDraft = (value: string) => setDrafts(d => ({ ...d, [draftKey]: value }))
  const files = attachments[draftKey] ?? []
  const setFiles = (next: File[]) => setAttachments(a => ({ ...a, [draftKey]: next }))
  const quote = quotes[draftKey]
  // Stable, so the messages that offer Reply do not draw again on every render.
  const quoteInChat = useCallback((text: string | undefined) => {
    const id = stateRef.current.view
    if (!id) return
    setQuotes(q => {
      const { [id]: _, ...rest } = q
      return text?.trim() ? { ...rest, [id]: text.trim() } : rest
    })
  }, [])
  // The server's own version until a session reports one (the start page has no session).
  const shownEnv = chat && Object.keys(chat.env).length ? chat.env : knownEnv
  const env: SessionEnv = useMemo(
    () => (info.version && !shownEnv.version ? { ...shownEnv, version: info.version } : shownEnv),
    [shownEnv, info.version],
  )
  const models = chat?.models.length
    ? chat.models
    : !knownModels.provider || knownModels.provider === account.account?.provider
      ? knownModels.models
      : []
  const uiName = (webSettings ? webSettings.uiName : env.uiName) || DEFAULT_UI_NAME
  // /daybreak's access program applies to the ChatGPT (Codex) sign-in only, not an OpenAI API key.
  const daybreak =
    account.account?.kind === 'chatgpt' && webSettings
      ? {
          value: webSettings.daybreak ?? 'off',
          onChange: (value: Daybreak) => void patchSettings({ daybreak: value }).then(setWebSettings, () => {}),
        }
      : undefined
  const previewing = !!preview && preview.sessionId === view
  const since = useTurnStart(chat?.busy, view)

  const openFile = useCallback(
    (path: string) => {
      if (!view) return
      setPreview({ sessionId: view, path })
      setSheetOpen(false)
    },
    [view],
  )
  const chatItems = chat?.items
  const chatFiles = useMemo(() => (chatItems ? sessionFiles(chatItems) : []), [chatItems])
  const chatCwd = chat?.cwd ?? chat?.workDir
  const filesValue = useMemo(
    () =>
      view
        ? {
            open: openFile,
            openImage: (src: string, n: number, target: string) => {
              setPreview({ sessionId: view, path: t('chatImage', { n: String(n) }), image: { src, target } })
              setSheetOpen(false)
            },
            base: filesBase(view),
            cwd: chatCwd,
            showFiles: () => {
              setPreview(undefined)
              setSideTab('files')
              if (isNarrow(760)) setSheetOpen(true)
            },
          }
        : {},
    [view, openFile, chatCwd, t],
  )
  const webPreviewValue = useMemo(() => {
    const target = (href: string) => previewTarget(href, { uiOrigin: location.origin, origins: info.previewOrigins })
    return {
      target,
      open: (url: string) => {
        const href = target(url)
        if (view && href) setPreview({ sessionId: view, url: href })
      },
      label: t('preview'),
    }
  }, [view, info.previewOrigins, t])
  const closePreview = useCallback(() => setPreview(undefined), [])
  const tasks = chat?.tasks
  // The names Agent calls gave their agents, as a string so streaming does not rebuild the context.
  const agentNames = useMemo(
    () =>
      [...agentInputs(chat?.items ?? [])]
        .filter(([, input]) => input.name)
        .map(([id, input]) => `${id}\t${input.name}`)
        .join('\n'),
    [chat?.items],
  )
  const agentsValue = useMemo(() => {
    const byToolUse = new Map(
      Object.values(tasks ?? {})
        .filter(task => task.toolUseId)
        .map(task => [task.toolUseId!, task]),
    )
    const names = new Map(
      agentNames
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [id, name] = line.split('\t') as [string, string]
          return [id, { name }]
        }),
    )
    return {
      byToolUse,
      sentTo: (input: string) => {
        const target = messageTarget(input, names)
        return target && (tasks?.[target.to] ?? (target.toolUseId ? byToolUse.get(target.toolUseId) : undefined))
      },
      open: (taskId: string) => {
        setPreview(undefined)
        const task = tasks?.[taskId]
        if (task?.type === 'local_workflow') {
          setWorkflowId(taskId)
          setSideTab('workflow')
        } else {
          setSideTab('agents')
          setAgentsView({ kind: 'task', id: taskId })
        }
        if (isNarrow(760)) setSheetOpen(true)
      },
    }
  }, [tasks, agentNames])
  useEffect(() => {
    setAgentsView({ kind: 'tree' })
    setWorkflowId(undefined)
    setSheetOpen(false)
  }, [view])
  const items = chat?.items
  // An agent the main conversation started that handed back its report or ended, under the turn it ended in.
  const agentNotes = useMemo(
    () =>
      notesByItem(
        (chat?.taskNotes ?? []).filter(note => {
          const task = tasks?.[note.taskId]
          return task !== undefined && (canChat(task) || task.type === 'local_bash' || task.type === 'local_workflow') && task.depth <= 1
        }),
        items ?? [],
      ),
    [chat?.taskNotes, tasks, items],
  )
  const agentNote = (note: TaskNote) => {
    const task = tasks?.[note.taskId]
    const { key, vars } = taskNoteText(note, task && { description: task.title ?? task.description, durationMs: task.durationMs })
    const done = key === 'taskFinishedNote'
    const kind = task?.type === 'local_bash' ? 'bash' : task?.type === 'local_workflow' ? 'workflow' : 'agent'
    const text = (
      {
        agent: { done: 'agentReturnedNote', failed: 'agentFailedNote', stopped: 'agentExitedNote' },
        bash: { done: 'bashDoneNote', failed: 'bashFailedNote', stopped: 'bashStoppedNote' },
        workflow: { done: 'workflowDoneNote', failed: 'workflowFailedNote', stopped: 'workflowStoppedNote' },
      } as const
    )[kind][done ? 'done' : key === 'taskFailedNote' ? 'failed' : 'stopped']
    return (
      <div className="pj-note agent-note" key={`${note.taskId}-${note.n}`}>
        <span className="g">{done ? '↩' : '■'}</span>
        <button type="button" onClick={() => agentsValue.open(note.taskId)}>
          {t(text, vars)} ›
        </button>
      </div>
    )
  }
  const sourcesById = useMemo(() => turnSources(items ?? [], agentsValue.byToolUse), [items, agentsValue])
  const chatTitle = state.history.find(h => h.id === view)?.title ?? 'Claude'

  const exportMarkdown = () => {
    if (!chat) return
    const text = chatMarkdown(chatTitle, chat.items, sourcesById, { you: t('you'), sources: t('sources') }, chat.model)
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

  const historyLimit = useRef(HISTORY_PAGE)
  const [sidebarLoaded, setSidebarLoaded] = useState(false)
  const untitledRetries = useRef({ ids: '', count: 0 })
  const refreshHistory = useCallback(async (more = false) => {
    if (more) historyLimit.current += HISTORY_PAGE
    try {
      const [data, running] = await Promise.all([loadSidebar(historyLimit.current), listRunning()])
      dispatch({ type: 'history', entries: data.sessions, folders: data.folders, more: data.more })
      dispatch({ type: 'running', ids: running.map(r => r.id) })
      // A running session listed by its id has no turn in its transcript yet. A page that is not
      // attached to it (e.g. reloaded just after its reply) gets no result to refresh on, so look
      // again a few times, backing off, until the CLI has written the turn. The retries are per
      // set of such sessions: a worker that only ever receives peer prompts stays listed by its
      // id for its whole run and must not use them up for the next reload.
      const untitled = data.sessions
        .filter(s => s.label === 'id' && running.some(r => r.id === s.id))
        .map(s => s.id)
        .sort()
        .join(',')
      if (untitled !== untitledRetries.current.ids) untitledRetries.current = { ids: untitled, count: 0 }
      if (untitled && untitledRetries.current.count < 5) {
        setTimeout(() => void refreshHistory(), 500 * 2 ** untitledRetries.current.count++)
      }
      setProjects(await listProjects())
      setSidebarLoaded(true)
    } catch {
      // The sidebar keeps what it has; the next refresh retries.
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    if (palette === 'default') delete root.dataset.palette
    else root.dataset.palette = palette
  }, [theme, palette])
  useEffect(() => {
    document.title = uiName
  }, [uiName])
  useEffect(() => {
    document.body.classList.toggle('nosess', !chat)
    document.body.classList.toggle('art', previewing)
    document.body.classList.toggle('proj', inProject)
  }, [chat, previewing, inProject])

  useEffect(() => {
    void refreshHistory()
    getWebSettings().then(setWebSettings, () => {})
    getInfo().then(
      res => {
        setHome(res.home)
        setInfo({ workspace: res.workspace, tempRoot: res.temp_root, previewOrigins: res.preview_origins ?? [], version: res.version })
      },
      () => {},
    )
    const map = sockets.current
    return () => {
      for (const socket of map.values()) socket.close()
    }
  }, [refreshHistory])

  // Messages that arrived while the reader was scrolled up, for the "↓ N new messages" button.
  const [newBelow, setNewBelow] = useState(0)
  const shownTurns = useRef<{ view?: string | null; n: number }>({ n: 0 })
  useEffect(() => {
    const feed = feedRef.current
    const n = chat?.items.length ?? 0
    const seen = shownTurns.current
    if (seen.view === view && n > seen.n && !stickToBottom.current) setNewBelow(k => k + n - seen.n)
    if (seen.view !== view || stickToBottom.current) setNewBelow(0)
    shownTurns.current = { view, n }
    if (!feed || !stickToBottom.current) return
    // Pinned to the bottom, the page follows the end itself; scroll anchoring would instead move
    // the view up when a reply laid out late is shorter than its estimate, which reads as the
    // reader scrolling up. A reader who scrolled up gets anchoring back (onScroll below).
    feed.style.overflowAnchor = 'none'
    feed.scrollTop = feed.scrollHeight
    // Replies off screen are laid out only when scrolled to (content-visibility), so the
    // ones landed on take their real height in a later frame; follow until the height
    // holds for two frames (a frame lays them out after its rAF callbacks).
    let height = feed.scrollHeight
    let same = 0
    let frames = 0
    let frame = requestAnimationFrame(function settle() {
      if (!stickToBottom.current) return
      feed.scrollTop = feed.scrollHeight
      same = feed.scrollHeight === height ? same + 1 : 0
      height = feed.scrollHeight
      if (same < 2 && ++frames < 20) frame = requestAnimationFrame(settle)
    })
    return () => cancelAnimationFrame(frame)
  }, [chat?.items, chat?.approvals, view])
  // An earlier page lands above the reader; keep what they were looking at in place.
  const fromBottom = useRef<number>(undefined)
  useLayoutEffect(() => {
    const feed = feedRef.current
    if (!feed || fromBottom.current === undefined) return
    feed.scrollTop = feed.scrollHeight - fromBottom.current
    fromBottom.current = undefined
  }, [chat?.items])

  // The server's own list, so a new browser or the first session already has the discovered models.
  const provider = account.account?.provider
  useEffect(() => {
    loadModels().then(
      models => {
        if (!models.length) return
        const known = { provider, models }
        setKnownModels(known)
        writeStored(MODELS_KEY, known)
      },
      () => {},
    )
  }, [provider])
  useEffect(() => {
    if (chat?.models.length) {
      const known = { provider: account.account?.provider, models: chat.models }
      setKnownModels(known)
      writeStored(MODELS_KEY, known)
    }
  }, [chat?.models, account.account?.provider])
  useEffect(() => {
    if (chat?.commands.length) {
      setKnownCommands(chat.commands)
      writeStored(COMMANDS_KEY, chat.commands)
    }
  }, [chat?.commands])
  const chatEnv = chat?.env
  useEffect(() => {
    if (chatEnv && Object.keys(chatEnv).length) {
      setKnownEnv(chatEnv)
      writeStored(ENV_KEY, chatEnv)
    }
  }, [chatEnv])

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
      pendingRequests.current.set(requestId, {
        id,
        settle: response => {
          if (response.subtype === 'error') reject(new Error(String(response.error ?? 'error')))
          else resolve((response.response ?? {}) as Record<string, unknown>)
        },
      })
    })

  const requestAsyncRef = useRef(requestAsync)
  requestAsyncRef.current = requestAsync
  // Stable per session so the dialogs do not refetch on every render.
  const control = useMemo(
    () =>
      view && chat?.mode === 'live'
        ? (body: Record<string, unknown>) => requestAsyncRef.current(view, REQUEST_PREFIX.ext, body)
        : undefined,
    [view, chat?.mode],
  )

  const stopTask = (id: string, taskId: string) =>
    request(id, REQUEST_PREFIX.stopTask, { subtype: 'stop_task', task_id: taskId })

  const sendToTask = async (
    id: string,
    taskId: string,
    text: string,
    pick: { model?: string; effort?: string } = {},
  ): Promise<void> => {
    await requestAsync(id, REQUEST_PREFIX.taskMessage, {
      subtype: 'send_task_message',
      task_id: taskId,
      text,
      ...pick,
    })
  }

  const getSettings = (id: string) => request(id, REQUEST_PREFIX.settings, { subtype: 'get_settings' })

  const attach = async (id: string): Promise<void> => {
    // Stream deltas come many times a frame; they are drawn once per frame.
    // Anything else draws the deltas before it first, so the order holds.
    let deltas: unknown[] = []
    let frame = 0
    const flush = () => {
      cancelAnimationFrame(frame)
      frame = 0
      if (!deltas.length) return
      const raws = deltas
      deltas = []
      dispatch({ type: 'chat', id, action: { type: 'messages', raws } })
    }
    const socket = await openSessionSocket(id, raw => {
      if ((raw as { type?: string }).type === 'stream_event') {
        deltas.push(raw)
        frame ||= requestAnimationFrame(flush)
        return
      }
      flush()
      const msg = raw as { type?: string; response?: Record<string, unknown> }
      const requestId = msg.type === 'control_response' ? msg.response?.request_id : undefined
      const pending = typeof requestId === 'string' && pendingRequests.current.get(requestId)
      if (pending) {
        pendingRequests.current.delete(requestId as string)
        pending.settle(msg.response!)
      }
      dispatch({ type: 'chat', id, action: { type: 'message', raw } })
      const reply = unsupportedControlResponse(raw)
      if (reply) socket.send(JSON.stringify(reply) + '\n')
      if (typeof requestId === 'string' && requestId.startsWith(REQUEST_PREFIX.effort)) getSettings(id)
      if ((raw as { type?: string }).type === 'result') {
        request(id, REQUEST_PREFIX.context, { subtype: 'get_context_usage' })
        request(id, REQUEST_PREFIX.rewindPoints, { subtype: 'rewind_points' })
        request(id, REQUEST_PREFIX.apps, { subtype: 'codex_apps' })
        void refreshHistory()
        // The CLI writes the turn to the transcript up to 100 ms after its result; read the title and folder again.
        setTimeout(() => void refreshHistory(), 500)
      }
    })
    socket.addEventListener('close', () => {
      flush()
      if (sockets.current.get(id) !== socket) return
      sockets.current.delete(id)
      // Nothing will answer the requests still in flight on this socket.
      for (const [requestId, pending] of pendingRequests.current) {
        if (pending.id !== id) continue
        pendingRequests.current.delete(requestId)
        pending.settle({ subtype: 'error', error: t('sessionEnded') })
      }
      dispatch({ type: 'mode', id, mode: 'readonly' })
      dispatch({ type: 'chat', id, action: { type: 'error', text: t('sessionEnded') } })
      void refreshHistory()
    })
    sockets.current.set(id, socket)
    dispatch({ type: 'mode', id, mode: 'live' })
    request(id, REQUEST_PREFIX.initialize, { subtype: 'initialize' })
    request(id, REQUEST_PREFIX.rewindPoints, { subtype: 'rewind_points' })
    getSettings(id)
    request(id, REQUEST_PREFIX.apps, { subtype: 'codex_apps' })
    // A session picked up mid-life has had turns already; a new one has nothing to count yet.
    if (stateRef.current.chats[id]?.items.length) request(id, REQUEST_PREFIX.context, { subtype: 'get_context_usage' })
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
      rewindPoints: page.rewindPoints,
    })
  }

  // A reload reopens the session or project in the address while a click on its row may open
  // it too: both opens would attach, and the server refuses the second socket, which then ends
  // the first one's view. Overlapping opens of one target share the first.
  const opening = useRef(new Map<string, Promise<void>>())
  const openOnce = (key: string, open: () => Promise<void>) => {
    const pending = opening.current.get(key)
    if (pending) return pending
    const run = open().finally(() => opening.current.delete(key))
    opening.current.set(key, run)
    return run
  }

  const openSession = (entry: HistoryEntry): Promise<void> => {
    setProjectId(undefined)
    stickToBottom.current = true
    dispatch({ type: 'view', id: entry.id })
    return openOnce(`s:${entry.id}`, () => loadSession(entry))
  }
  const loadSession = async (entry: HistoryEntry) => {
    if (stateRef.current.chats[entry.id]) return
    dispatch({ type: 'mode', id: entry.id, mode: 'readonly' })
    const findLive = async () => (await listRunning().catch(() => [])).find(r => r.id === entry.id)
    for (let wait = 200; ; wait *= 2) {
      try {
        await loadInto(entry.id)
        break
      } catch (err) {
        // A running session's turn reaches its transcript up to 100 ms after the reply, so a
        // reload right after one can find nothing yet; read again before giving up. Any other
        // error (a failed read, the server gone) is shown at once.
        const notWrittenYet = err instanceof ApiError && err.status === 404
        if (notWrittenYet && (await findLive())) {
          if (wait <= 1600) {
            await new Promise(resolve => setTimeout(resolve, wait))
            continue
          }
          // Still running with nothing to read (a worker fed only peer prompts never writes a
          // visible turn): open it empty and attach below rather than report it missing.
          dispatch({ type: 'loaded', id: entry.id, messages: [], start: 0 })
          break
        }
        dispatch({
          type: 'chat',
          id: entry.id,
          action: { type: 'error', text: err instanceof Error ? err.message : String(err) },
        })
        return
      }
    }
    // A session still running with no tab attached is picked up directly.
    const live = await findLive()
    if (live?.attached) dispatch({ type: 'mode', id: entry.id, mode: 'elsewhere' })
    else if (live) await attach(entry.id).catch(() => {})
  }

  /** Shows a project: starts or resumes its coordinator and attaches to it. */
  const openProject = (p: Project): Promise<void> => {
    setSidebarOpen(false)
    setPreview(undefined)
    setStartError(undefined)
    setProjectId(p.id)
    return openOnce(`p:${p.id}`, () => connectProject(p))
  }
  const connectProject = async (p: Project) => {
    try {
      const created = await openCoordinator(p.id)
      const id = created.session_id
      setProjects(list => list.map(x => (x.id === p.id ? { ...x, coordinator_session_id: id, running: true } : x)))
      dispatch({ type: 'view', id })
      if (!stateRef.current.chats[id]) {
        dispatch({ type: 'mode', id, mode: 'connecting' })
        const empty = () => dispatch({ type: 'loaded', id, messages: [], start: 0, workDir: created.work_dir })
        // A new coordinator has no transcript yet.
        if (created.fresh) empty()
        else await loadInto(id).catch(empty)
      }
      if (sockets.current.has(id)) return
      const running = await listRunning().catch(() => [])
      if (running.find(r => r.id === id)?.attached) dispatch({ type: 'mode', id, mode: 'elsewhere' })
      else await attach(id)
    } catch (err) {
      setProjectId(undefined)
      dispatch({ type: 'view', id: null })
      setStartError(t('connectFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  // The open session or project is kept in the address (`#s=<id>`, `#p=<id>`), so a reload reopens it.
  const restoreTo = useRef(/^#([sp])=([\w-]+)$/.exec(location.hash))
  const hashTarget = inProject && projectId ? `#p=${projectId}` : view ? `#s=${view}` : ''
  useEffect(() => {
    if (restoreTo.current) return
    if (location.hash !== hashTarget) history.replaceState(null, '', hashTarget || location.pathname + location.search)
  }, [hashTarget])
  useEffect(() => {
    const want = restoreTo.current
    if (!want) return
    if (!sidebarLoaded) return
    restoreTo.current = null
    const [, kind, id] = want
    const p = kind === 'p' ? projects.find(x => x.id === id) : undefined
    const entry = kind === 's' ? state.history.find(h => h.id === id) : undefined
    if (p) void openProject(p)
    else if (entry) void openSession(entry)
    // Gone (deleted, archived): the start page, without the stale address.
    else history.replaceState(null, '', location.pathname + location.search)
  }, [sidebarLoaded])

  /** The project keeps a permission mode only once the live coordinator accepted it. */
  const changeProjectMode = async (p: Project, id: string, mode: string) => {
    if (sockets.current.has(id)) {
      try {
        await requestAsync(id, REQUEST_PREFIX.mode, { subtype: 'set_permission_mode', mode })
      } catch {
        // The reducer shows the refusal as the chat notice.
        return
      }
    } else {
      changeMode(id, mode)
    }
    setProjects(list => list.map(x => (x.id === p.id ? { ...x, permission_mode: mode } : x)))
    patchProject(p.id, { permission_mode: mode }).catch(() => {})
  }

  /** Starts the process for a read-only transcript (prewarm on focus). */
  const resume = async (id: string): Promise<boolean> => {
    const current = stateRef.current.chats[id]
    if (!current || current.mode === 'live') return true
    // A project or session opened a moment ago shows its box while it still attaches: a message
    // sent then waits for that instead of being turned away.
    if (current.mode === 'connecting') {
      await Promise.all([...opening.current.values()])
      return sockets.current.has(id)
    }
    if (current.mode === 'elsewhere') return false
    dispatch({ type: 'mode', id, mode: 'connecting' })
    try {
      const running = await listRunning()
      if (running.find(r => r.id === id)?.attached) {
        dispatch({ type: 'mode', id, mode: 'elsewhere' })
        return false
      }
      const entry = stateRef.current.history.find(h => h.id === id)
      // A coordinator restarts through its project, with its prompt and settings.
      const owner = projectsRef.current.find(p => p.coordinator_session_id === id)
      if (owner) await openCoordinator(owner.id)
      else {
        await createSession({
          resume: id,
          cwd: current.workDir ?? entry?.cwd,
          ...(current.permissionMode && { permission_mode: current.permissionMode }),
        })
      }
      await attach(id)
      return true
    } catch (err) {
      dispatch({ type: 'mode', id, mode: 'readonly' })
      dispatch({
        type: 'chat',
        id,
        action: {
          type: 'local',
          patch: { notice: t('resumeFailed', { error: err instanceof Error ? err.message : String(err) }) },
        },
      })
      return false
    }
  }

  /** Sends a prompt the page writes itself (`/compact`, `/goal clear`, a retry); `recap` sends `/recap` with no bubble. */
  const sendPrompt = async (id: string, text: string, recap?: { away?: number }, images?: string[]) => {
    const current = stateRef.current.chats[id]
    if (!current || current.busy || current.mode === 'elsewhere') return
    if (current.mode !== 'live' && !(await resume(id))) return
    stickToBottom.current = true
    const uuid = newUuid()
    dispatch({ type: 'chat', id, action: recap ? { type: 'recap', away: recap.away } : { type: 'user', text, images, uuid } })
    send(id, userMessage(text, images, uuid))
  }

  /** A bare `/stats`, `/config`, … opens the page's own panel instead of going to the session. */
  const openNative = (text: string, key: string) => {
    const native = nativeCommand(text)
    if (!native) return false
    setDrafts(d => ({ ...d, [key]: '' }))
    if ('menu' in native) {
      // The model menu under the input box (it holds the effort levels too).
      const button = document.querySelector<HTMLElement>(`.main .footbtn[aria-label="${t('model')}"]`)
      if (!button) return false
      setTimeout(() => button.click())
      return true
    }
    setSettingsTab(native.tab)
    setDialog(native.dialog)
    return true
  }

  // A chat's messages go out one at a time, in the order typed, even while an earlier one uploads.
  const chatSends = useRef<Promise<void>>(Promise.resolve())
  const sendInChat = async (now = false) => {
    const id = state.view
    const text = draft.trim()
    const pending = files
    if (!id || !chat || (!text && !pending.length)) return
    if (!pending.length && openNative(text, id)) return
    if (text === '/recap' && !pending.length) {
      if (chat.busy) return
      setDrafts(d => ({ ...d, [id]: '' }))
      await sendPrompt(id, text, {})
      return
    }
    const picked = (agentTargets[id] ?? []).filter(x => chat.tasks[x.id])
    const replyTo = text.startsWith('/') ? undefined : quotes[id]
    const prompt = replyPrompt(replyTo, text)
    setDrafts(d => ({ ...d, [id]: '' }))
    setAttachments(a => ({ ...a, [id]: [] }))
    if (replyTo) setQuotes(({ [id]: _, ...rest }) => rest)
    if (picked.length) setAgentTargets(x => ({ ...x, [id]: [] }))
    // A message that could not go out returns to an empty box.
    const restore = () => {
      if (replyTo) setQuotes(q => (q[id] ? q : { ...q, [id]: replyTo }))
      setDrafts(d => (d[id] ? d : { ...d, [id]: text }))
      setAttachments(a => (a[id]?.length ? a : { ...a, [id]: pending }))
      if (picked.length) setAgentTargets(x => (x[id]?.length ? x : { ...x, [id]: picked }))
    }
    const run = chatSends.current.then(async () => {
      if (chat.mode !== 'live' && !(await resume(id))) return restore()
      if (picked.length) {
        let mentions: string[]
        try {
          mentions = await Promise.all(pending.map(async f => mentionPath((await uploadFile(id, f)).path)))
        } catch (err) {
          restore()
          dispatch({ type: 'chat', id, action: { type: 'local', patch: { notice: err instanceof Error ? err.message : String(err) } } })
          return
        }
        try {
          // The same message to every picked agent, files uploaded once.
          const message = [prompt, mentions.join(' ')].filter(Boolean).join('\n\n')
          for (const x of picked) await sendToTask(id, x.id, message)
          // The message shows in the agent's own conversation.
          agentsValue.open(picked[0]!.id)
        } catch (err) {
          dispatch({ type: 'chat', id, action: { type: 'local', patch: { notice: err instanceof Error ? err.message : String(err) } } })
        }
        return
      }
      let content: { text: string; images: string[] }
      try {
        content = await prepareContent(id, prompt, pending)
      } catch (err) {
        restore()
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
      stickToBottom.current = true
      if (chat.notice) dispatch({ type: 'chat', id, action: { type: 'local', patch: { notice: undefined } } })
      const uuid = newUuid()
      // The turn may have started or ended while the content was prepared: read busy now.
      const busy = stateRef.current.chats[id]?.busy ?? chat.busy
      dispatch({ type: 'chat', id, action: { type: busy ? 'queue' : 'user', ...content, uuid } })
      // 'now' gets in front of the model without waiting for the turn, like the TUI's ctrl+enter.
      send(id, { ...userMessage(content.text, content.images, uuid), ...(now && { priority: 'now' }) })
    })
    chatSends.current = run.catch(() => {})
    await run
  }

  /** A comment pinned on the file preview goes out as its own message; the draft stays. */
  const sendComment = async (id: string, text: string) => {
    const current = stateRef.current.chats[id]
    if (!current || current.mode === 'elsewhere') return
    if (current.mode !== 'live' && !(await resume(id))) return
    stickToBottom.current = true
    const uuid = newUuid()
    dispatch({ type: 'chat', id, action: { type: stateRef.current.chats[id]?.busy ? 'queue' : 'user', text, uuid } })
    send(id, userMessage(text, undefined, uuid))
  }

  const startChat = async (trust = false) => {
    const text = (drafts[''] ?? '').trim()
    const pending = attachments[''] ?? []
    if (!text && !pending.length) return
    if (!pending.length && openNative(text, '')) return
    const { cwd, mode, model, temporary, effort } = state.start
    setTrustDir(undefined)
    let createdId: string | undefined
    try {
      const created = await createSession({
        ...(temporary ? { temporary: true } : cwd && { cwd, ...(trust && { trust }) }),
        ...(mode !== 'default' && { permission_mode: mode }),
        ...(model && { model }),
      })
      const id = created.session_id
      createdId = id
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
      if (effort) changeEffort(id, effort)
      const uuid = newUuid()
      dispatch({ type: 'chat', id, action: { type: 'user', ...content, uuid } })
      send(id, userMessage(content.text, content.images, uuid))
    } catch (err) {
      if (err instanceof NeedsTrustError) setTrustDir(err.directory)
      else setStartError(t('connectFailed', { error: err instanceof Error ? err.message : String(err) }))
      // The session was created but its socket never opened: a chat left 'connecting' can be
      // neither sent to nor resumed, so let the user resume it from read-only.
      if (createdId && stateRef.current.chats[createdId]?.mode === 'connecting') {
        dispatch({ type: 'mode', id: createdId, mode: 'readonly' })
      }
    }
  }

  // Back after five minutes or more away: a one-line `/recap` (the TUI's away
  // summary), unless a turn is running or the last thing shown is already one.
  useEffect(() => {
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now()
        return
      }
      const away = Math.floor((Date.now() - hiddenAt) / 60_000)
      const id = stateRef.current.view
      const current = id ? stateRef.current.chats[id] : undefined
      if (!hiddenAt || away < 5 || !id || !current || current.busy || current.mode !== 'live') return
      if (current.items.findLast(i => i.kind === 'user' || i.kind === 'recap')?.kind !== 'user') return
      void sendPrompt(id, '/recap', { away })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  })

  /** Drops a prompt and everything after it (`rewind_conversation`), optionally restoring files first. */
  const rewindChat = async (id: string, userId: string, withFiles: boolean): Promise<boolean> => {
    setRewindTarget(undefined)
    const current = stateRef.current.chats[id]
    if (!current || (current.mode !== 'live' && !(await resume(id)))) return false
    try {
      // The prompts the engine holds now: a resume can drop what a compaction summarized.
      const { uuids } = await requestAsync(id, REQUEST_PREFIX.rewindPoints, { subtype: 'rewind_points' })
      const points = Array.isArray(uuids) ? uuids : []
      if (!points.includes(userId)) throw new Error(t('rewindGone'))
      const lastSeen = points.at(-1)
      let restored = 0
      if (withFiles) {
        // Only a dry run reports which files differ; the restore itself does not.
        const preview = await requestAsync(id, REQUEST_PREFIX.rewind, { subtype: 'rewind_files', user_message_id: userId, dry_run: true })
        restored = Array.isArray(preview.filesChanged) ? preview.filesChanged.length : 0
        await requestAsync(id, REQUEST_PREFIX.rewind, { subtype: 'rewind_files', user_message_id: userId })
      }
      const result = await requestAsync(id, REQUEST_PREFIX.rewind, {
        subtype: 'rewind_conversation',
        target_message_uuid: userId,
        last_seen_user_message_uuid: lastSeen,
      })
      if (result.rewound !== true) throw new Error(String(result.reason ?? result.error ?? 'refused'))
      const note = withFiles ? t('rewoundFiles', { n: String(restored) }) : t('rewound')
      dispatch({ type: 'chat', id, action: { type: 'rewound', userId, note } })
      setDrafts(d => ({ ...d, [id]: typeof result.prefillText === 'string' ? result.prefillText : '' }))
      setTimeout(() => document.querySelector<HTMLTextAreaElement>('.cbox textarea')?.focus())
      return true
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      dispatch({ type: 'chat', id, action: { type: 'local', patch: { notice: t('rewindFailed', { error }) } } })
      return false
    }
  }

  /** The prompt a reply answered and the reply's last API message id, by the reply's first id. */
  const turnOf = (id: string, firstId: string) => {
    const items = stateRef.current.chats[id]?.items ?? []
    const turn = joinTurns(items).find(x => x.item.id === firstId)
    const at = items.findIndex(i => i.id === firstId)
    const user = items.slice(0, at).findLast(i => i.kind === 'user')
    const points = stateRef.current.chats[id]?.rewindPoints
    return {
      user: user?.kind === 'user' && points?.includes(user.id) ? user : undefined,
      last: turn?.ids.at(-1),
    }
  }

  /** Asks the same prompt again: rewinds to it, then sends it. */
  const retryTurn = async (id: string, firstId: string) => {
    const { user } = turnOf(id, firstId)
    if (!user || !(await rewindChat(id, user.id, false))) return
    setDrafts(d => ({ ...d, [id]: '' }))
    await sendPrompt(id, user.text, undefined, user.images)
  }

  /** Opens a new session holding the conversation up to this reply. */
  const forkTurn = async (id: string, firstId: string) => {
    const { last } = turnOf(id, firstId)
    if (!last) return
    try {
      const { session_id: forkId } = await forkSession(id, last)
      await refreshHistory()
      await openSession(stateRef.current.history.find(h => h.id === forkId) ?? { ...stateRef.current.history.find(h => h.id === id)!, id: forkId })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      dispatch({ type: 'chat', id, action: { type: 'local', patch: { notice: t('forkFailed', { error }) } } })
    }
  }

  // The drawer's search box can take focus only once the drawer is open.
  const searchOnOpen = useRef(false)
  const focusSearch = () => {
    if (isNarrow(1100) && !sidebarOpen) {
      searchOnOpen.current = true
      setSidebarOpen(true)
    } else searchRef.current?.focus()
  }
  // The sessions drawer (≤1100px) takes focus when it opens and gives it back
  // to the menu button when it closes; Esc closes it.
  useEffect(() => {
    if (!sidebarOpen) return
    if (searchOnOpen.current) {
      searchOnOpen.current = false
      searchRef.current?.focus()
    } else document.querySelector<HTMLElement>('.sessions .new-chat')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const active = document.activeElement
      if (!active || active === document.body || active.closest('.sessions')) menuRef.current?.focus()
    }
  }, [sidebarOpen])

  // The phone's bottom sheet likewise takes focus and returns it to the panel button.
  useEffect(() => {
    if (!sheetOpen) return
    document.querySelector<HTMLElement>('.side [role=tab][aria-selected=true]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheetOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const active = document.activeElement
      if (!active || active === document.body || active.closest('.side')) {
        document.querySelector<HTMLElement>('#panel-btn')?.focus()
      }
    }
  }, [sheetOpen])

  const openStatus = () => {
    setPreview(undefined)
    setSideTab('status')
    if (isNarrow(760)) setSheetOpen(true)
  }
  // Page shortcuts: Ctrl+K search, Ctrl+Shift+O new session, Ctrl+. Status, ? help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]')
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        focusSearch()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        newChat()
      } else if (mod && e.key === '.') {
        e.preventDefault()
        if (stateRef.current.view) openStatus()
      } else if (e.key === '?' && !mod && !typing && !dialog) {
        e.preventDefault()
        setDialog('keys')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  /** ctrl+enter on an empty box or "Send now": queued messages interrupt the turn and run now. */
  const sendQueuedNow = (id: string) => {
    for (const q of stateRef.current.chats[id]?.queued ?? []) {
      void requestAsync(id, REQUEST_PREFIX.cancelQueued, { subtype: 'cancel_async_message', message_uuid: q.id }).then(
        r => {
          // Not cancelled: the model already read it.
          if (r.cancelled !== true) return
          // A uuid the engine has seen is dropped as a duplicate, so it goes again under a new one.
          const uuid = newUuid()
          dispatch({ type: 'chat', id, action: { type: 'requeue', from: q.id, to: uuid } })
          send(id, { ...userMessage(q.text, q.images, uuid), priority: 'now' })
        },
        () => {},
      )
    }
  }
  const sendNowInChat = () => {
    const id = stateRef.current.view
    if (!id) return
    if (draft.trim() || files.length) void sendInChat(true)
    else sendQueuedNow(id)
  }

  /** Interrupts the turn; like the TUI, messages still queued go back into the input box. */
  const stop = (id: string) => {
    const queued = stateRef.current.chats[id]?.queued ?? []
    if (queued.length) {
      dispatch({ type: 'chat', id, action: { type: 'unqueue' } })
      // Sent before the interrupt, which would otherwise run them as the next turn.
      const cancels = queued.map(q =>
        requestAsync(id, REQUEST_PREFIX.cancelQueued, { subtype: 'cancel_async_message', message_uuid: q.id }).then(
          r => r.cancelled === true,
          () => false,
        ),
      )
      void Promise.all(cancels).then(results => {
        // One the model already read (not cancelled) shows up through its echo.
        const back = queued.filter((_, i) => results[i])
        if (!back.length) return
        setDrafts(d => ({ ...d, [id]: [...back.map(q => q.text), d[id] ?? ''].filter(Boolean).join('\n') }))
        const images = back
          .flatMap(q => q.images ?? [])
          .flatMap((url, i) => dataUrlFile(url, `image-${i + 1}`) ?? [])
        if (images.length) setAttachments(a => ({ ...a, [id]: [...(a[id] ?? []), ...images] }))
      })
    }
    request(id, REQUEST_PREFIX.interrupt, { subtype: 'interrupt' })
  }

  const answer = (id: string, approval: Approval, choice: ApprovalChoice) => {
    send(id, permissionResponse(approval, choice))
    dispatch({ type: 'chat', id, action: { type: 'answered', approval, choice } })
    // "Deny and tell Claude what to do": the answer goes in the input box.
    if (choice === 'deny') document.querySelector<HTMLTextAreaElement>('.cbox textarea')?.focus()
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
    if (sockets.current.has(id)) request(id, REQUEST_PREFIX.model, { subtype: 'set_model', model })
  }

  function changeEffort(id: string, effort: string) {
    dispatch({ type: 'chat', id, action: { type: 'local', patch: { effort, notice: undefined } } })
    if (sockets.current.has(id)) {
      request(id, REQUEST_PREFIX.effort, { subtype: 'apply_flag_settings', settings: { effortLevel: effort } })
    }
  }

  function newChat({ cwd, temporary = false }: { cwd?: string; temporary?: boolean } = {}) {
    setProjectId(undefined)
    setStartError(undefined)
    setSidebarOpen(false)
    dispatch({ type: 'startOptions', patch: { cwd, temporary } })
    dispatch({ type: 'view', id: null })
  }

  const useSkill = (name: string) => {
    setDialog(undefined)
    setDraft(`/${name} `)
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('.cbox textarea, .wl-box textarea')?.focus())
  }

  // Settings > Usage: the open session's /usage, or this machine's plan limits.
  const live = !!view && chat?.mode === 'live'
  const chatAgents = Object.values(agentTasks(chat?.tasks ?? {}))
  const usageSource = {
    usage: () => (live ? (requestAsync(view, REQUEST_PREFIX.usage, { subtype: 'get_usage' }) as Promise<Usage>) : getUsage()),
    context: live
      ? () => requestAsync(view, REQUEST_PREFIX.context, { subtype: 'get_context_usage' }) as Promise<ContextUsage>
      : undefined,
    tools: (chat?.items ?? []).reduce<Record<string, number>>((acc, item) => {
      if (item.kind === 'assistant') for (const b of item.blocks) if (b.kind === 'tool') acc[b.name] = (acc[b.name] ?? 0) + 1
      return acc
    }, {}),
    subagents: { total: chatAgents.length, running: chatAgents.filter(task => !isFinished(task)).length },
    live,
  }

  const menuButton = (
    <button
      type="button"
      ref={menuRef}
      className="menu-btn"
      aria-label={t('openSessions')}
      aria-controls="sessions"
      aria-expanded={sidebarOpen}
      onClick={() => setSidebarOpen(true)}
    >
      ☰
    </button>
  )

  // Coordinators are reached through their project, not the folder list.
  const projectSessions = new Set(projects.flatMap(p => (p.coordinator_session_id ? [p.coordinator_session_id] : [])))
  // Task counts come from the server's tasks table.
  const sidebarProjects = projects.map(
    (p): SidebarProject => ({ ...p, tasks: p.task_count, tasksRunning: p.running_tasks, needsYou: p.needs_you }),
  )
  /** The open project's rows as its view last fetched them, fresher than the project list. */
  const countTasks = (projectId: string, rows: ProjectTask[]) =>
    setProjects(list =>
      list.map(x =>
        x.id === projectId
          ? {
              ...x,
              task_count: rows.length,
              running_tasks: rows.filter(r => r.state === 'running' || r.state === 'blocked').length,
              needs_you: rows.filter(r => r.state === 'blocked' || r.state === 'review').length,
            }
          : x,
      ),
    )

  const statusText = chat
    ? chat.busy && chat.mode === 'live' && since !== undefined
      ? t('elapsedRunning', { time: formatElapsed(Date.now() - since) })
      : t(
          chat.mode === 'live'
            ? chat.busy
              ? 'statusLive'
              : 'statusReady'
            : chat.mode === 'elsewhere'
              ? 'statusElsewhere'
              : chat.mode === 'connecting'
                ? 'statusConnecting'
                : 'statusIdle',
        )
    : ''
  const approval = chat?.approvals[0]
  const listFiles = useCallback((query: string) => (view ? listWorkspaceFiles(view, query) : Promise.resolve([])), [view])
  const statusRequest = useCallback(
    (body: Record<string, unknown>) => (view ? requestAsync(view, REQUEST_PREFIX.status, body) : Promise.resolve({})),
    [view],
  )
  const prompts = useMemo(
    () => (chatItems ?? []).flatMap(i => (i.kind === 'user' && i.text ? [i.text] : [])),
    [chatItems],
  )
  // Teammates and workers update the shared task list outside this transcript, so a live session reads it back.
  const [taskList, setTaskList] = useState<{ view: string; todos: Todo[] }>()
  const planned = useMemo(() => usesTaskList(chatItems ?? []), [chatItems])
  const itemCount = chatItems?.length ?? 0
  useEffect(() => {
    if (!view || !planned || !live) return
    let current = true
    statusRequest({ subtype: 'get_task_list' }).then(body => {
      const todos = taskListTodos(body)
      if (current && todos?.length) setTaskList({ view, todos })
    }, () => {})
    return () => {
      current = false
    }
  }, [view, planned, live, itemCount, chat?.busy, statusRequest])
  const derivedTodos = useMemo(() => currentTodos(chatItems ?? []), [chatItems])
  const todos = taskList?.view === view ? taskList.todos : derivedTodos
  // The session's folder for the shared ↑ history; a temporary chat has none.
  const historyDir = chat?.workDir ?? chat?.cwd
  const historyScope = useMemo(
    () => (view && historyDir && !(info.tempRoot && historyDir.startsWith(info.tempRoot)) ? { cwd: historyDir, sessionId: view } : undefined),
    [view, historyDir, info.tempRoot],
  )
  const team = useMemo(() => (chat ? buildTeam(chat.tasks, chat.items) : undefined), [chat])
  const agentMentions: MentionTarget[] = chatAgents.filter(canChat).map(task => ({
    id: task.id,
    name: team?.members.find(m => m.task.id === task.id)?.name ?? (task.description || taskName(task)),
    detail: task.status,
    tag: t('agentTag'),
  }))
  // Every message reads this context, so it changes only when what it offers does, not on each streamed delta.
  const latest = useRef({ items: chatItems, rewindChat, retryTurn, forkTurn, turnOf })
  latest.current = { items: chatItems, rewindChat, retryTurn, forkTurn, turnOf }
  const canRewind = !!view && !!chat && !chat.busy && chat.mode !== 'elsewhere'
  const decisions = chat?.decisions
  const rewindPoints = chat?.rewindPoints
  const chatValue = useMemo(
    () => ({
      decisions,
      rewind:
        view && canRewind
          ? {
              target: rewindTarget,
              points: new Set(rewindPoints),
              turnsAfter: (id: string) => (rewindPoints ? rewindPoints.length - rewindPoints.indexOf(id) : 0),
              ask: setRewindTarget,
              go: (id: string, withFiles: boolean) => void latest.current.rewindChat(view, id, withFiles),
            }
          : undefined,
      turn:
        view && canRewind
          ? {
              hasPrompt: (firstId: string) => !!latest.current.turnOf(view, firstId).user,
              retry: (firstId: string) => void latest.current.retryTurn(view, firstId),
              fork: (firstId: string) => void latest.current.forkTurn(view, firstId),
              rewind: (firstId: string) => {
                const { user } = latest.current.turnOf(view, firstId)
                if (user) setRewindTarget(user.id)
              },
            }
          : undefined,
    }),
    [decisions, canRewind, view, rewindTarget, rewindPoints],
  )

  const withChat = (node: ReactNode) => (
    <AgentsContext.Provider value={agentsValue}>
      <FilesContext.Provider value={filesValue}>
        <ChatContext.Provider value={chatValue}>
          <WebPreviewContext.Provider value={webPreviewValue}>{node}</WebPreviewContext.Provider>
        </ChatContext.Provider>
      </FilesContext.Provider>
    </AgentsContext.Provider>
  )

  const main = inProject ? null : !chat ? (
    <StartPage
      t={t}
      env={env}
      options={state.start}
      setOptions={patch => dispatch({ type: 'startOptions', patch })}
      workspace={info.workspace}
      history={state.history.filter(h => !h.archived && !h.projectId)}
      tempRoot={info.tempRoot}
      models={models}
      commands={knownCommands}
      daybreak={daybreak}
      draft={drafts[''] ?? ''}
      setDraft={v => setDrafts(d => ({ ...d, '': v }))}
      files={attachments[''] ?? []}
      setFiles={next => setAttachments(a => ({ ...a, '': next }))}
      error={startError}
      trustDir={trustDir}
      onTrust={() => void startChat(true)}
      onCancelTrust={() => setTrustDir(undefined)}
      onStart={() => void startChat()}
      onOpen={entry => void openSession(entry)}
      onViewAll={focusSearch}
      menuButton={menuButton}
      gate={<LoginGate t={t} api={account} onKeyDialog={setKeyDialog} />}
      signedOut={signedOut}
    />
  ) : (
    withChat(
        <>
          <div className="meta">
            {menuButton}
            <span className={`chip status status-${chat.mode}`} role="status">
              <span className={`dot ${chat.busy ? 'running' : chat.mode === 'live' ? 'completed' : 'idle'}`} />
              {statusText}
            </span>
            <span className="chip mono" title={chatCwd}>
              {tilde(chatCwd ?? '')}
            </span>
            {chat.contextPercent !== undefined && (
              <ContextChip
                t={t}
                percent={chat.contextPercent}
                context={chat.context}
                onOpen={() => view && sockets.current.has(view) && request(view, REQUEST_PREFIX.context, { subtype: 'get_context_usage' })}
                onCompact={chat.mode === 'elsewhere' ? undefined : () => view && void sendPrompt(view, '/compact')}
              />
            )}
            <span className="sp" />
            {chat.items.length > 0 && (
              <div className="export">
                <FootMenu button={t('export')}>
                  {close => (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          close()
                          exportMarkdown()
                        }}
                      >
                        {t('exportMarkdown')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          close()
                          exportPdf()
                        }}
                      >
                        {t('exportPdf')}
                      </button>
                    </>
                  )}
                </FootMenu>
              </div>
            )}
            <button
              type="button"
              className="menu-btn panel-btn"
              id="panel-btn"
              aria-label={t('openPanel')}
              aria-expanded={sheetOpen}
              onClick={() => {
                setPreview(undefined)
                setSheetOpen(true)
              }}
            >
              ▤
            </button>
          </div>
          {team && <TeamBar t={t} team={team} name={teamName(chat.items)} onOpen={agentsValue.open} />}
          <QuoteOnSelect t={t} feed={feedRef} onQuote={quoteInChat} />
          <QuoteContext.Provider value={quoteInChat}>
          <div
            className="feed"
            ref={feedRef}
            aria-busy={chat.busy}
            onScroll={e => {
              stickToBottom.current = followScroll(e.currentTarget, stickToBottom.current, feedTop)
              e.currentTarget.style.overflowAnchor = stickToBottom.current ? 'none' : ''
              if (stickToBottom.current && newBelow) setNewBelow(0)
            }}
          >
            {chat.start > 0 && (
              <div className="older-sentinel">
                <button
                  type="button"
                  onClick={() => {
                    const feed = feedRef.current
                    if (feed) fromBottom.current = feed.scrollHeight - feed.scrollTop
                    if (view) void loadInto(view, chat.start)
                  }}
                >
                  {t('loadEarlier')}
                </button>
              </div>
            )}
            {joinTurns(chat.items, id => agentNotes.has(id)).map(({ item, ids }) => (
              <Fragment key={item.id}>
                <Message
                  item={item}
                  t={t}
                  fallbackModel={chat.model}
                  models={models}
                  streaming={chat.busy && ids.includes(chat.streamingId ?? '')}
                  sources={ids.map(id => sourcesById.get(id)).find(Boolean)}
                />
                {agentNotes.get(ids.at(-1)!)?.map(agentNote)}
              </Fragment>
            ))}
            {agentNotes.get('')?.map(agentNote)}
            {chat.queued.map(item => (
              <Message key={item.id} item={item} t={t} streaming={false} queued />
            ))}
            {chat.queued.length > 0 && view && (
              <div className="queued-now">
                <button type="button" onClick={() => sendQueuedNow(view)}>
                  {t('sendNow')}
                </button>
                <span className="sub">{t('sendNowHint')}</span>
              </div>
            )}
            {chat.approvals.map(a => (
              <div className="ask-ref" key={a.requestId}>
                <span className="spin" aria-hidden="true" />
                {t('askRef', { tool: a.toolName })}
              </div>
            ))}
            {chat.busy && since !== undefined && <StatusLine t={t} since={since} retry={chat.retry} onStop={() => view && stop(view)} />}
            {newBelow > 0 && (
              <button
                type="button"
                className="new-below"
                onClick={() => {
                  const feed = feedRef.current
                  stickToBottom.current = true
                  setNewBelow(0)
                  feed?.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' })
                }}
              >
                ↓ {t('newMessages', { n: String(newBelow) })}
              </button>
            )}
          </div>
          </QuoteContext.Provider>
          <div className="composer">
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
            <LoginGate t={t} api={account} onKeyDialog={setKeyDialog} />
            {approval && view && (
              <AskDock
                approval={approval}
                more={chat.approvals.length - 1}
                cwd={chat.cwd ?? chat.workDir}
                t={t}
                onAnswer={choice => answer(view, approval, choice)}
              />
            )}
            <Pins t={t} todos={todos} />
            <ChatComposer
              t={t}
              busy={chat.busy}
              disabled={chat.mode === 'elsewhere'}
              signedOut={signedOut}
              draft={draft}
              setDraft={setDraft}
              onSend={() => void sendInChat()}
              onSendNow={sendNowInChat}
              quote={quote}
              onQuote={quoteInChat}
              onStop={() => view && stop(view)}
              onFocus={() => view && chat.mode === 'readonly' && void resume(view)}
              files={files}
              setFiles={setFiles}
              targets={agentMentions}
              picked={view ? (agentTargets[view] ?? []).filter(x => chat.tasks[x.id]) : []}
              onTarget={x => view && setAgentTargets(a => ({ ...a, [view]: x }))}
              tools={{
                ...chatTools(chat, listFiles, prompts, historyScope, mode => view && changeMode(view, mode)),
                model: {
                  model: chat.model,
                  effort: chat.effort,
                  models,
                  onModel: model => view && changeModel(view, model),
                  onEffort: effort => view && changeEffort(view, effort),
                  daybreak,
                },
              }}
              extra={chat.goal && <GoalMenu t={t} goal={chat.goal} onClear={() => view && void sendPrompt(view, '/goal clear')} />}
            />
          </div>
        </>,
    )
  )

  return (
    <div
      className="app"
      style={columnVars(columns) as CSSProperties}
    >
      <ColumnDrag side="left" label={t('resizeSessions')} columns={columns} onChange={setColumns} />
      {chat && view && !inProject && (
        <ColumnDrag side="right" label={t('resizePanel')} columns={columns} onChange={setColumns} />
      )}
      <Sidebar
        t={t}
        lang={lang}
        open={sidebarOpen}
        uiName={uiName}
        env={env}
        history={projectSessions.size ? state.history.filter(h => !projectSessions.has(h.id)) : state.history}
        historyMore={state.historyMore}
        folders={state.folders}
        running={state.running}
        view={view}
        tempRoot={info.tempRoot}
        searchRef={searchRef}
        onNew={start => newChat(start)}
        onOpen={entry => {
          setSidebarOpen(false)
          void openSession(entry)
        }}
        onPatched={(id, patch) => dispatch({ type: 'meta', id, patch })}
        onDeleted={id => {
          sockets.current.get(id)?.close()
          sockets.current.delete(id)
          dispatch({ type: 'removed', id })
          if (stateRef.current.view === id) newChat()
        }}
        onMore={() => void refreshHistory(true)}
        onDialog={kind => {
          setSidebarOpen(false)
          setDialog(kind)
        }}
        projects={sidebarProjects}
        projectId={inProject ? projectId : undefined}
        onProject={p => void openProject(p)}
        onNewProject={() => {
          setSidebarOpen(false)
          setProjectDialog('new')
        }}
        onProjectSettings={p => {
          setSidebarOpen(false)
          setProjectDialog(p)
        }}
        onProjectChanged={(id, changed) => {
          setProjects(list => (changed ? list.map(x => (x.id === id ? changed : x)) : list.filter(x => x.id !== id)))
          if (!changed && id === projectId) newChat()
          if (!changed) void refreshHistory()
        }}
        account={
          <AccountCard
            t={t}
            api={account}
            onKeyDialog={setKeyDialog}
            onDialog={kind => {
              setSidebarOpen(false)
              setDialog(kind)
            }}
          />
        }
      />
      {previewing && preview && (
        <section className="artview" aria-label={t('artifact')}>
          <WebPreviewContext.Provider value={webPreviewValue}>
            {'url' in preview ? (
              <WebPreview url={preview.url} t={t} onClose={closePreview} />
            ) : (
              <Preview
                sessionId={preview.sessionId}
                path={preview.path}
                t={t}
                onClose={closePreview}
                files={chatFiles}
                onOpen={openFile}
                image={preview.image}
                onComment={signedOut ? undefined : text => void sendComment(preview.sessionId, text)}
              />
            )}
          </WebPreviewContext.Provider>
        </section>
      )}
      {inProject &&
        view &&
        withChat(
          <ProjectView
            key={project.id}
            t={t}
            project={project}
            chat={chat}
            models={models}
            menuButton={menuButton}
            signedOut={signedOut}
            draft={draft}
            setDraft={setDraft}
            files={files}
            setFiles={setFiles}
            onSend={() => void sendInChat()}
            onStop={() => stop(view)}
            onFocus={() => chat.mode === 'readonly' && void resume(view)}
            quote={quote}
            onQuote={quoteInChat}
            listFiles={listFiles}
            prompts={prompts}
            onMode={mode => void changeProjectMode(project, view, mode)}
            onModel={model => changeModel(view, model)}
            onEffort={effort => changeEffort(view, effort)}
            onAnswer={(approval, choice) => answer(view, approval, choice)}
            onSettings={() => setProjectDialog(project)}
            onStopTask={taskId => requestAsync(view, REQUEST_PREFIX.stopTask, { subtype: 'stop_task', task_id: taskId })}
            onSendTask={async (taskId, text, pick) => {
              // A coordinator that stopped (or a server that restarted) is resumed first.
              if (chat.mode !== 'live' && !(await resume(view))) throw new Error(t('statusIdle'))
              return sendToTask(view, taskId, text, pick)
            }}
            onSendCoordinator={text => sendPrompt(view, text)}
            onTasks={rows => countTasks(project.id, rows)}
            uploadTo={view}
            moved={state.history.filter(h => h.projectId === project.id)}
            onOpenSession={entry => void openSession(entry)}
            onLoadEarlier={() => void loadInto(view, chat.start)}
            daybreak={daybreak}
          />,
        )}
      <main
        className={`main${approval ? ' asking' : ''}${dragging ? ' dragging' : ''}`}
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
          if (e.defaultPrevented || !e.dataTransfer.files.length || chat?.mode === 'elsewhere') return
          e.preventDefault()
          setFiles([...files, ...e.dataTransfer.files])
        }}
      >
        {main}
      </main>
      {chat && view && !inProject && (
        <SidePanel
          t={t}
          open={sheetOpen}
          tab={sideTab}
          setTab={setSideTab}
          sessionId={view}
          chat={chat}
          title={chatTitle}
          models={models}
          statusText={statusText}
          currentFile={preview && 'path' in preview ? preview.path : undefined}
          agentsView={agentsView}
          setAgentsView={setAgentsView}
          workflowId={workflowId}
          setWorkflowId={setWorkflowId}
          onOpenFile={openFile}
          onStopTask={taskId => stopTask(view, taskId)}
          onStatusRequest={statusRequest}
          onCompact={chat.mode === 'elsewhere' ? undefined : () => void sendPrompt(view, '/compact')}
          todos={todos}
          onSendTask={(taskId, text, pick) => sendToTask(view, taskId, text, pick)}
          agentInput={{
            tools: chatTools(chat, listFiles, [], historyScope, mode => changeMode(view, mode)),
            model: chat.model,
            effort: chat.effort,
            models,
            signedOut,
          }}
          onRequest={body => requestAsync(view, REQUEST_PREFIX.background, body)}
          onClose={() => setSheetOpen(false)}
        />
      )}
      {sidebarOpen && <div className="scrim" aria-hidden="true" onClick={() => setSidebarOpen(false)} />}
      {sheetOpen && (
        <div className="scrim" style={{ zIndex: 26 }} aria-hidden="true" onClick={() => setSheetOpen(false)} />
      )}
      {dialog && (
        <AppDialog
          kind={dialog}
          t={t}
          lang={lang}
          control={control}
          onClose={() => {
            setDialog(undefined)
            setSettingsTab(undefined)
          }}
          onUseSkill={useSkill}
          onOpenSession={id => {
            const entry = state.history.find(h => h.id === id)
            if (!entry) return
            setDialog(undefined)
            void openSession(entry)
          }}
          settings={{
            lang,
            setLang,
            theme,
            setTheme,
            palette,
            setPalette,
            initialTab: settingsTab,
            workspace: info.workspace,
            settings: webSettings,
            onSettings: patch => {
              patchSettings(patch).then(setWebSettings, () => {})
            },
            account: account.account,
            usage: usageSource,
            models,
          }}
        />
      )}
      {projectDialog && (
        <ProjectDialog
          t={t}
          project={projectDialog === 'new' ? undefined : projectDialog}
          workspace={info.workspace}
          models={models}
          inheritModel={
            projectDialog === 'new'
              ? undefined
              : ((inProject && project?.id === projectDialog.id ? chat?.model : undefined) ?? projectDialog.coordinator_model ?? undefined)
          }
          onClose={() => setProjectDialog(undefined)}
          onSaved={saved => {
            setProjectDialog(undefined)
            setProjects(list => [saved, ...list.filter(x => x.id !== saved.id)])
            // A new project starts with the coordinator's input box focused.
            if (projectDialog === 'new')
              void openProject(saved).then(() =>
                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#projview .pv-chat textarea')?.focus()),
              )
          }}
        />
      )}
      {keyDialog && <ApiKeyDialog t={t} api={account} provider={keyDialog} onClose={() => setKeyDialog(undefined)} />}
    </div>
  )
}
