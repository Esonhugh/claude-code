import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  type AuthProvider,
  createSession,
  getInfo,
  getSettings as getWebSettings,
  getUsage,
  listProjects,
  listRunning,
  listWorkspaceFiles,
  loadSidebar,
  loadTranscript,
  NeedsTrustError,
  openCoordinator,
  openSessionSocket,
  patchProject,
  patchSettings,
  type Project,
  type ProjectTask,
  type Usage,
  type WebSettings,
} from './api'
import { buildTeam } from './agents'
import { AccountCard, ApiKeyDialog, LoginGate, useAccount } from './components/Account'
import type { AgentsView } from './components/Agents'
import { AskDock, ContextChip, GoalMenu, InputBox, ModeButton, ModelMenu, modelButtonLabel, Pins } from './components/Composer'
import { AppDialog, type Palette, type Theme } from './components/Dialogs'
import type { ContextUsage } from './components/Settings'
import { AgentsContext, ChatContext, FilesContext, Message, TeamBar } from './components/Message'
import { Preview } from './components/Preview'
import { ProjectDialog } from './components/ProjectDialog'
import { ProjectView } from './components/ProjectView'
import { type DialogKind, Sidebar, type SidebarProject } from './components/Sidebar'
import { SidePanel, type SideTab } from './components/SidePanel'
import { StartPage } from './components/StartPage'
import { FootMenu, formatElapsed, nextMode, readStored, type T, writeStored } from './components/ui'
import { WebPreview } from './components/WebPreview'
import { chatMarkdown, exportFileName } from './exportChat'
import { filesBase, IMAGE_TYPES, mentionPath, readAsDataUrl, setHome, tilde, uploadFile } from './files'
import { initialLang, type Lang, type MessageKey, saveLang, translate } from './i18n'
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
  teamName,
  unsupportedControlResponse,
  userMessage,
} from './protocol'
import { turnSources } from './sources'
import { appReducer, type HistoryEntry, initialAppState, type SessionChat } from './store'
import { previewTarget, WebPreviewContext } from './webPreview'

const HISTORY_PAGE = 200
const MODELS_KEY = 'claude-web-models'
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
function StatusLine({ t, since, onStop }: { t: T; since: number; onStop: () => void }) {
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
  const [palette, setPaletteState] = useState<Palette>(() => readStored(PALETTE_KEY, 'default'))
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<Record<string, File[]>>({})
  const [preview, setPreview] = useState<
    { sessionId: string; path: string } | { sessionId: string; url: string }
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
  const pendingRequests = useRef(new Map<string, (response: Record<string, unknown>) => void>())
  const [knownModels, setKnownModels] = useState<ModelOption[]>(() => readStored(MODELS_KEY, []))
  const [knownEnv, setKnownEnv] = useState<SessionEnv>(() => readStored(ENV_KEY, {}))
  const sockets = useRef(new Map<string, WebSocket>())
  const requestSeq = useRef(0)
  const feedRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  const stickToBottom = useRef(true)
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
  // The server's own version until a session reports one (the start page has no session).
  const shownEnv = chat && Object.keys(chat.env).length ? chat.env : knownEnv
  const env: SessionEnv = useMemo(
    () => (info.version && !shownEnv.version ? { ...shownEnv, version: info.version } : shownEnv),
    [shownEnv, info.version],
  )
  const models = chat?.models.length ? chat.models : knownModels
  const uiName = (webSettings ? webSettings.uiName : env.uiName) || DEFAULT_UI_NAME
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
  const chatCwd = chat?.cwd ?? chat?.workDir
  const filesValue = useMemo(
    () =>
      view
        ? {
            open: openFile,
            base: filesBase(view),
            cwd: chatCwd,
            showFiles: () => {
              setPreview(undefined)
              setSideTab('files')
              if (isNarrow(760)) setSheetOpen(true)
            },
          }
        : {},
    [view, openFile, chatCwd],
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
  const agentsValue = useMemo(
    () => ({
      byToolUse: new Map(
        Object.values(tasks ?? {})
          .filter(task => task.toolUseId)
          .map(task => [task.toolUseId!, task]),
      ),
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
    }),
    [tasks],
  )
  useEffect(() => {
    setAgentsView({ kind: 'tree' })
    setWorkflowId(undefined)
    setSheetOpen(false)
  }, [view])
  const items = chat?.items
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
  const refreshHistory = useCallback(async (more = false) => {
    if (more) historyLimit.current += HISTORY_PAGE
    try {
      const [data, running] = await Promise.all([loadSidebar(historyLimit.current), listRunning()])
      dispatch({ type: 'history', entries: data.sessions, folders: data.folders, more: data.more })
      dispatch({ type: 'running', ids: running.map(r => r.id) })
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

  useEffect(() => {
    const feed = feedRef.current
    if (feed && stickToBottom.current) feed.scrollTop = feed.scrollHeight
  }, [chat?.items, chat?.approvals, view])

  useEffect(() => {
    if (chat?.models.length) {
      setKnownModels(chat.models)
      writeStored(MODELS_KEY, chat.models)
    }
  }, [chat?.models])
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
      pendingRequests.current.set(requestId, response => {
        if (response.subtype === 'error') reject(new Error(String(response.error ?? 'error')))
        else resolve((response.response ?? {}) as Record<string, unknown>)
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
  ): Promise<string> => {
    const body = await requestAsync(id, REQUEST_PREFIX.taskMessage, {
      subtype: 'send_task_message',
      task_id: taskId,
      text,
      ...pick,
    })
    const delivery = String(body.delivery ?? '')
    return delivery === 'queued' || delivery === 'injected' || delivery === 'resumed'
      ? t(`delivery_${delivery}` as MessageKey)
      : delivery
  }

  const getSettings = (id: string) => request(id, REQUEST_PREFIX.settings, { subtype: 'get_settings' })

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
      if (typeof requestId === 'string' && requestId.startsWith(REQUEST_PREFIX.effort)) getSettings(id)
      if ((raw as { type?: string }).type === 'result') {
        request(id, REQUEST_PREFIX.context, { subtype: 'get_context_usage' })
        void refreshHistory()
        // The CLI writes the turn to the transcript up to 100 ms after its result; read the title and folder again.
        setTimeout(() => void refreshHistory(), 500)
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
    getSettings(id)
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
    })
  }

  const openSession = async (entry: HistoryEntry) => {
    setProjectId(undefined)
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

  /** Shows a project: starts or resumes its coordinator and attaches to it. */
  const openProject = async (p: Project) => {
    setSidebarOpen(false)
    setPreview(undefined)
    setStartError(undefined)
    setProjectId(p.id)
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
    if (current.mode === 'connecting' || current.mode === 'elsewhere') return false
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

  /** Sends a prompt the page writes itself (`/compact`, `/goal clear`); `recap` sends `/recap` with no bubble. */
  const sendPrompt = async (id: string, text: string, recap?: { away?: number }) => {
    const current = stateRef.current.chats[id]
    if (!current || current.busy || current.mode === 'elsewhere') return
    if (current.mode !== 'live' && !(await resume(id))) return
    stickToBottom.current = true
    const uuid = newUuid()
    dispatch({ type: 'chat', id, action: recap ? { type: 'recap', away: recap.away } : { type: 'user', text, uuid } })
    send(id, userMessage(text, [], uuid))
  }

  const sendInChat = async () => {
    const id = state.view
    const text = draft.trim()
    const pending = files
    if (!id || !chat || (!text && !pending.length) || chat.busy) return
    if (text === '/recap' && !pending.length) {
      setDrafts(d => ({ ...d, [id]: '' }))
      await sendPrompt(id, text, {})
      return
    }
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
    const uuid = newUuid()
    dispatch({ type: 'chat', id, action: { type: 'user', ...content, uuid } })
    send(id, userMessage(content.text, content.images, uuid))
  }

  const startChat = async (trust = false) => {
    const text = (drafts[''] ?? '').trim()
    const pending = attachments[''] ?? []
    if (!text && !pending.length) return
    const { cwd, mode, model, temporary, effort } = state.start
    setTrustDir(undefined)
    try {
      const created = await createSession({
        ...(temporary ? { temporary: true } : cwd && { cwd, ...(trust && { trust }) }),
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
      if (effort) changeEffort(id, effort)
      const uuid = newUuid()
      dispatch({ type: 'chat', id, action: { type: 'user', ...content, uuid } })
      send(id, userMessage(content.text, content.images, uuid))
    } catch (err) {
      if (err instanceof NeedsTrustError) setTrustDir(err.directory)
      else setStartError(t('connectFailed', { error: err instanceof Error ? err.message : String(err) }))
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
  const rewindChat = async (id: string, userId: string, withFiles: boolean) => {
    setRewindTarget(undefined)
    const current = stateRef.current.chats[id]
    if (!current || (current.mode !== 'live' && !(await resume(id)))) return
    const lastSeen = stateRef.current.chats[id]?.items.findLast(i => i.kind === 'user')?.id
    try {
      let restored = 0
      if (withFiles) {
        const files = await requestAsync(id, REQUEST_PREFIX.rewind, { subtype: 'rewind_files', user_message_id: userId })
        restored = Array.isArray(files.filesChanged) ? files.filesChanged.length : 0
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
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      dispatch({ type: 'chat', id, action: { type: 'local', patch: { notice: t('rewindFailed', { error }) } } })
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

  const stop = (id: string) => request(id, REQUEST_PREFIX.interrupt, { subtype: 'interrupt' })

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
  const usageSource = {
    usage: () => (live ? (requestAsync(view, REQUEST_PREFIX.usage, { subtype: 'get_usage' }) as Promise<Usage>) : getUsage()),
    context: live
      ? () => requestAsync(view, REQUEST_PREFIX.context, { subtype: 'get_context_usage' }) as Promise<ContextUsage>
      : undefined,
    tools: (chat?.items ?? []).reduce<Record<string, number>>((acc, item) => {
      if (item.kind === 'assistant') for (const b of item.blocks) if (b.kind === 'tool') acc[b.name] = (acc[b.name] ?? 0) + 1
      return acc
    }, {}),
    subagents: Object.values(chat?.tasks ?? {}).filter(task => task.type !== 'local_workflow').length,
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
            ? 'statusLive'
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
  const chatItems = chat?.items
  const prompts = useMemo(
    () => (chatItems ?? []).flatMap(i => (i.kind === 'user' && i.text ? [i.text] : [])),
    [chatItems],
  )
  const todos = useMemo(() => currentTodos(chatItems ?? []), [chatItems])
  const team = useMemo(() => (chat ? buildTeam(chat.tasks, chat.items) : undefined), [chat])
  const chatValue = useMemo(
    () => ({
      decisions: chat?.decisions,
      rewind:
        view && chat && !chat.busy && chat.mode !== 'elsewhere'
          ? {
              target: rewindTarget,
              turnsAfter: (id: string) => {
                const index = chat.items.findIndex(i => i.id === id)
                return chat.items.slice(index).filter(i => i.kind === 'user').length
              },
              ask: setRewindTarget,
              go: (id: string, withFiles: boolean) => void rewindChat(view, id, withFiles),
            }
          : undefined,
    }),
    [chat, view, rewindTarget],
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
          <div
            className="feed"
            ref={feedRef}
            aria-busy={chat.busy}
            onScroll={e => {
              const el = e.currentTarget
              stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            }}
          >
            {chat.start > 0 && (
              <div className="older-sentinel">
                <button type="button" onClick={() => view && void loadInto(view, chat.start)}>
                  {t('loadEarlier')}
                </button>
              </div>
            )}
            {chat.items.map(item => (
              <Message
                key={item.id}
                item={item}
                t={t}
                fallbackModel={chat.model}
                models={models}
                streaming={chat.busy && item.id === chat.streamingId}
                sources={sourcesById.get(item.id)}
              />
            ))}
            {chat.approvals.map(a => (
              <div className="ask-ref" key={a.requestId}>
                <span className="spin" aria-hidden="true" />
                {t('askRef', { tool: a.toolName })}
              </div>
            ))}
            {chat.busy && since !== undefined && <StatusLine t={t} since={since} onStop={() => view && stop(view)} />}
          </div>
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
            <InputBox
              t={t}
              busy={chat.busy}
              disabled={chat.mode === 'elsewhere'}
              signedOut={signedOut}
              draft={draft}
              setDraft={setDraft}
              onSend={() => void sendInChat()}
              onStop={() => view && stop(view)}
              onFocus={() => view && chat.mode === 'readonly' && void resume(view)}
              files={files}
              setFiles={setFiles}
              commands={chat.commands}
              hiddenCommands={chat.terminalCommands}
              skills={chat.env.skills}
              listFiles={listFiles}
              prompts={prompts}
              onShiftTab={() => view && changeMode(view, nextMode(chat.permissionMode, chat.env.planMode))}
              crow={
                <>
                  <ModeButton
                    t={t}
                    mode={chat.permissionMode ?? 'default'}
                    plan={chat.env.planMode}
                    onMode={mode => view && changeMode(view, mode)}
                  />
                  {chat.goal && (
                    <GoalMenu t={t} goal={chat.goal} onClear={() => view && void sendPrompt(view, '/goal clear')} />
                  )}
                  {models.length > 0 && (
                    <FootMenu right label={t('model')} button={modelButtonLabel(chat.model, chat.effort, models, t)}>
                      {close => (
                        <ModelMenu
                          t={t}
                          model={chat.model}
                          effort={chat.effort}
                          models={models}
                          onModel={model => view && changeModel(view, model)}
                          onEffort={effort => view && changeEffort(view, effort)}
                          close={close}
                        />
                      )}
                    </FootMenu>
                  )}
                </>
              }
            />
          </div>
        </>,
    )
  )

  return (
    <div className="app">
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
        dialogOpen={!!dialog}
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
              <Preview sessionId={preview.sessionId} path={preview.path} t={t} onClose={closePreview} />
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
            onTasks={rows => countTasks(project.id, rows)}
            uploadTo={view}
            moved={state.history.filter(h => h.projectId === project.id)}
            onOpenSession={entry => void openSession(entry)}
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
          if (!e.dataTransfer.files.length || chat?.mode === 'elsewhere') return
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
          todos={todos}
          onSendTask={(taskId, text) => sendToTask(view, taskId, text)}
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
          onClose={() => setDialog(undefined)}
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
