import {
  type CSSProperties,
  type DragEvent,
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { listTasks, loadTaskTranscript, type Project, type ProjectTask, reviewTask } from '../api'
import { mentionPath, tilde, uploadFile } from '../files'
import {
  agentInputs,
  canMessage,
  isLive,
  notesByItem,
  TASK_GROUPS,
  TASK_LANES,
  taskMeta,
  taskModel,
  taskNoteText,
  type TaskState,
  withApprovals,
  workerItems,
} from '../projects'
import { type Approval, type ApprovalChoice, type Block, currentTodos, initialState, type ModelOption, reduce, type TaskNote } from '../protocol'
import type { HistoryEntry, SessionChat } from '../store'
import { AskDock, ChatComposer, chatTools, type ComposerTools } from './Composer'
import { Dialog } from './Dialog'
import { joinTurns, Message, modelName } from './Message'
import { WORKER_MODELS } from './ProjectDialog'
import { followScroll, readStored, type T, writeStored } from './ui'

type Show = 'chat' | 'tasks'

/** The width of the coordinator column, kept per browser. */
const WIDTH_KEY = 'claude-web-pv-width'

/** A model alias or id as the prototype names it (`Opus 5.5`). */
function modelLabel(value: string | null | undefined, models: ModelOption[]): string | undefined {
  if (!value) return undefined
  return WORKER_MODELS.find(m => m.value === value)?.label ?? modelName(value, models) ?? value
}

function TaskCard({
  t,
  task,
  summary,
  meta,
  current,
  onOpen,
  onMenu,
}: {
  t: T
  task: Pick<ProjectTask, 'id' | 'title' | 'state'>
  summary: string
  meta: string
  current: boolean
  onOpen: () => void
  onMenu?: (e: MouseEvent) => void
}) {
  const state = task.state
  return (
    <button
      type="button"
      className="pjcard"
      aria-current={current}
      data-task={task.id}
      onClick={onOpen}
      onContextMenu={onMenu}
    >
      <span className={`dot ${state === 'done' ? '' : state}`} />
      <span className="tt">{task.title}</span>
      <span className={`pjbadge ${state}`}>{t(`taskState_${state}`)}</span>
      <span className="sm">{summary}</span>
      <span className="mt">{meta}</span>
    </button>
  )
}

/** A dispatched task in the coordinator's chat: an inline link with a hover card of its state and latest activity. */
function TaskLink({
  t,
  task,
  meta,
  activity,
  current,
  onOpen,
  onMenu,
}: {
  t: T
  task: Pick<ProjectTask, 'id' | 'title' | 'state'>
  meta: string
  activity: string
  current: boolean
  onOpen?: () => void
  onMenu?: (e: MouseEvent) => void
}) {
  const state = task.state
  return (
    <span className="tasklink">
      <span className="g">↳</span>
      {t('handedTo')}
      <button type="button" className={`tl-chip ${state}`} aria-current={current} data-task={task.id} onClick={onOpen} onContextMenu={onMenu}>
        {state === 'running' ? <span className="spin" aria-hidden="true" /> : <span className={`dot ${state === 'done' ? '' : state}`} />}
        <span className="tt">{task.title}</span>
      </button>
      <span className="tl-card" role="tooltip">
        <span className="tl-row">
          <span className={`pjbadge ${state}`}>{t(`taskState_${state}`)}</span>
          {meta && <span className="mono">{meta}</span>}
        </span>
        {activity && <span className="tl-act">{activity}</span>}
      </span>
    </span>
  )
}

/** The worker's conversation, fetched from its transcript a page of new messages at a time. */
function useWorkerTranscript(projectId: string, task: ProjectTask, followUntil: number): unknown[] {
  const [messages, setMessages] = useState<unknown[]>([])
  const next = useRef(0)
  const [poll, setPoll] = useState(0)
  const live = isLive(task)
  useEffect(() => {
    next.current = 0
    setMessages([])
  }, [task.id])
  useEffect(() => {
    // The worker's last lines can reach its transcript after the task is reported ended.
    const until = live ? 0 : Math.max(followUntil, Date.now() + 6000)
    const timer = setInterval(() => {
      if (live || Date.now() < until) setPoll(n => n + 1)
      else clearInterval(timer)
    }, 1500)
    return () => clearInterval(timer)
  }, [live, followUntil])
  useEffect(() => {
    let current = true
    loadTaskTranscript(projectId, task.id, next.current).then(
      page => {
        if (!current) return
        next.current = page.next
        if (page.reset) setMessages(page.messages)
        else if (page.messages.length) setMessages(prev => [...prev, ...page.messages])
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [projectId, task.id, task.state, task.tool_uses, task.summary, poll])
  return messages
}

/** The open task: checklist, brief, the worker's conversation and its own input box. */
function TaskPane({
  t,
  project,
  task,
  model,
  effort,
  models,
  head,
  approvals,
  tools,
  signedOut,
  draft,
  setDraft,
  files,
  setFiles,
  notice,
  followUntil,
  meta,
  pick,
  onPick,
  onSend,
  onAnswer,
}: {
  t: T
  project: Project
  task: ProjectTask
  model: string | undefined
  effort: string | undefined
  models: ModelOption[]
  head: ReactNode
  approvals: Approval[]
  /** The coordinator's palette, files and mode; the model row is the task's own. */
  tools: Omit<ComposerTools, 'prompts' | 'model'>
  signedOut?: boolean
  draft: string
  setDraft: (v: string) => void
  files: File[]
  setFiles: (files: File[]) => void
  notice?: string
  followUntil: number
  meta: string
  pick: { model?: string; effort?: string }
  onPick: (pick: { model?: string; effort?: string }) => void
  onSend: () => void
  onAnswer: (approval: Approval, choice: ApprovalChoice) => void
}) {
  const messages = useWorkerTranscript(project.id, task, followUntil)
  const items = useMemo(() => messages.reduce(reduce, initialState).items, [messages])
  const shown = useMemo(() => workerItems(items, task.brief), [items, task.brief])
  const todos = useMemo(() => currentTodos(items), [items])
  const prompts = useMemo(() => items.flatMap(i => (i.kind === 'user' && i.text ? [i.text] : [])), [items])
  const feedRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const feedTop = useRef(0)
  useEffect(() => {
    const feed = feedRef.current
    if (feed && atBottom.current) feed.scrollTop = feed.scrollHeight
  }, [shown.length, task.state])
  const live = isLive(task)
  const open = canMessage(task)
  const approval = approvals[0]
  const done = todos.filter(x => x.status === 'completed').length
  return (
    <>
      {head}
      <div className="feed" ref={feedRef} onScroll={e => (atBottom.current = followScroll(e.currentTarget, atBottom.current, feedTop))}>
        <div className="pjcheck">
          <b>{task.title}</b>
          {todos.map((todo, i) => (
            <div key={i} className={`todo-i ${todo.status}`}>
              <span>{todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'}</span>
              <span>{todo.content}</span>
            </div>
          ))}
          <span className="note">
            {todos.length > 0 && `${done}/${todos.length} · `}
            <span className={`pjbadge ${task.state}`}>{t(`taskState_${task.state}`)}</span>
            {task.worktree && (
              <>
                {' · '}
                <span className="mono">{tilde(task.worktree)}</span>
              </>
            )}
          </span>
        </div>
        {task.brief && (
          <div className="msg">
            <span className="who">{t('taskBrief')}</span>
            <div className="pjbrief">{task.brief}</div>
          </div>
        )}
        {joinTurns(shown).map(({ item }) => (
          <Message key={item.id} item={item} t={t} who="worker" fallbackModel={model} models={models} streaming={false} />
        ))}
        {task.state === 'running' && (
          <div className="status-line">
            <span className="glyph">✻</span>
            <span className="verb shimmer">Working…</span>
            <span className="mono">{meta}</span>
          </div>
        )}
      </div>
      <div className="composer">
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {approval && (
          <AskDock
            approval={approval}
            more={approvals.length - 1}
            cwd={task.worktree ?? project.cwd}
            t={t}
            onAnswer={choice => onAnswer(approval, choice)}
          />
        )}
        <ChatComposer
          t={t}
          agent
          busy={false}
          disabled={!open}
          signedOut={signedOut}
          draft={draft}
          setDraft={setDraft}
          onSend={() => {
            atBottom.current = true
            onSend()
          }}
          onStop={() => {}}
          files={files}
          setFiles={setFiles}
          placeholder={t(!open ? 'taskPhStopped' : live ? 'taskPhRunning' : 'taskPhEnded')}
          tools={{
            ...tools,
            prompts,
            model: {
              model: pick.model ?? model,
              effort,
              models,
              heading: live ? t('taskModelLocked') : t('taskModelNext'),
              locked: live,
              onModel: value => onPick({ ...pick, model: value }),
              onEffort: level => onPick({ ...pick, effort: level }),
            },
          }}
        />
      </div>
    </>
  )
}

type TaskMenu = { task: ProjectTask; x: number; y: number }

/**
 * A project: its coordinator conversation in the middle, the tasks it
 * dispatched on the right (docs/design/claude-web-project.md section 2).
 * Both input boxes share the project's permission mode.
 */
export function ProjectView({
  t,
  project,
  chat,
  models,
  menuButton,
  signedOut,
  draft,
  setDraft,
  files,
  setFiles,
  onSend,
  onStop,
  onFocus,
  listFiles,
  prompts,
  onMode,
  onModel,
  onEffort,
  onAnswer,
  onSettings,
  onStopTask,
  onSendTask,
  onTasks,
  uploadTo,
  moved,
  onOpenSession,
  onLoadEarlier,
}: {
  t: T
  project: Project
  chat: SessionChat
  models: ModelOption[]
  menuButton: ReactNode
  signedOut?: boolean
  draft: string
  setDraft: (v: string) => void
  files: File[]
  setFiles: (files: File[]) => void
  onSend: () => void
  onStop: () => void
  onFocus: () => void
  listFiles: (query: string) => Promise<string[]>
  prompts: string[]
  onMode: (mode: string) => void
  onModel: (model: string) => void
  onEffort: (effort: string) => void
  onAnswer: (approval: Approval, choice: ApprovalChoice) => void
  onSettings: () => void
  /** Rejects when the coordinator is gone or refuses the stop. */
  onStopTask: (taskId: string) => Promise<unknown>
  /** Resolves with the delivery (`queued`, `resumed`…); an ended task resumes on `model` and `effort`. */
  onSendTask: (taskId: string, text: string, pick: { model?: string; effort?: string }) => Promise<string>
  /** The task rows as last fetched, for the sidebar's counts. */
  onTasks: (rows: ProjectTask[]) => void
  /** The coordinator's session id: task attachments are uploaded there. */
  uploadTo: string
  /** Sessions moved into this project from the sidebar; they open as the chats they are. */
  moved: HistoryEntry[]
  onOpenSession: (entry: HistoryEntry) => void
  /** Prepends the transcript page before `chat.start`. */
  onLoadEarlier?: () => void
}) {
  const [show, setShow] = useState<Show>('chat')
  const [wide, setWide] = useState(false)
  const [width, setWidth] = useState<number | undefined>(() => readStored<number | undefined>(WIDTH_KEY, undefined))
  const [openId, setOpenId] = useState<string>()
  const [board, setBoard] = useState(false)
  const [rows, setRows] = useState<ProjectTask[]>([])
  const [refresh, setRefresh] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({})
  const [taskFiles, setTaskFiles] = useState<Record<string, File[]>>({})
  const [picks, setPicks] = useState<Record<string, { model?: string; effort?: string }>>({})
  const [taskNotice, setTaskNotice] = useState<string>()
  const [followUntil, setFollowUntil] = useState(0)
  const [menu, setMenu] = useState<TaskMenu | null>(null)
  const [flash, setFlash] = useState<string>()
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const feedRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const onTasksRef = useRef(onTasks)
  onTasksRef.current = onTasks

  // Refetched whenever the stream reports on a task or an approval comes or goes;
  // the server folds each line into the table before relaying it.
  const streamKey = useMemo(
    () =>
      Object.values(chat.tasks)
        .map(x => `${x.id}:${x.status}:${x.toolUses ?? ''}:${x.summary ?? ''}`)
        .join('|') + `#${chat.approvals.map(a => a.requestId).join(',')}`,
    [chat.tasks, chat.approvals],
  )
  useEffect(() => {
    let current = true
    listTasks(project.id).then(
      next => {
        if (!current) return
        setRows(next)
        onTasksRef.current(next)
      },
      () => {},
    )
    return () => {
      current = false
    }
  }, [project.id, streamKey, refresh])

  const tasks = useMemo(() => withApprovals(rows, chat.approvals), [rows, chat.approvals])
  const anyLive = tasks.some(isLive)
  // The running clock, and a slower refetch for the tokens read from the workers' transcripts.
  useEffect(() => {
    if (!anyLive) return
    let n = 0
    const timer = setInterval(() => {
      setNow(Date.now())
      if (++n % 3 === 0) setRefresh(r => r + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [anyLive])
  useEffect(() => () => clearTimeout(flashTimer.current), [])

  const inputs = useMemo(() => agentInputs(chat.items), [chat.items])
  const notes = useMemo(() => notesByItem(chat.taskNotes, chat.items), [chat.taskNotes, chat.items])
  const byToolUse = useMemo(() => new Map(tasks.filter(x => x.tool_use_id).map(x => [x.tool_use_id!, x])), [tasks])
  // Until the coordinator's first turn reports them, the model and effort it was started with.
  const chatModel = chat.model ?? project.coordinator_model ?? undefined
  const chatEffort = chat.effort ?? project.coordinator_effort ?? undefined
  const coordinatorModel =
    !chatModel || chatModel === 'default' ? (models.find(m => m.value === 'default')?.resolvedModel ?? chatModel) : chatModel
  const modelOf = (task: ProjectTask) =>
    picks[task.id]?.model ??
    taskModel(task, task.tool_use_id ? inputs.get(task.tool_use_id) : undefined, project.worker_model, coordinatorModel)
  const metaOf = (task: ProjectTask) => taskMeta(task, modelLabel(modelOf(task), models), now)
  const summaryOf = (task: ProjectTask) =>
    task.state === 'stopped' && task.stop_reason === 'restart'
      ? t('taskStoppedRestart')
      : task.state === 'stopped' && task.stop_reason === 'exited'
        ? t('taskStoppedExited')
        : task.state === 'stopped' && task.stop_reason === 'failed' && task.error
          ? t('taskFailedReason', { error: task.error })
          : (task.summary ?? '')
  const mode = chat.permissionMode ?? project.permission_mode
  const running = tasks.filter(x => x.state === 'running').length
  const blocked = tasks.filter(x => x.state === 'blocked').length
  const open = openId ? tasks.find(x => x.id === openId) : undefined

  // Task rows and the replayed task events land after the chat and grow its cards; follow them while the user is at the bottom.
  const atBottom = useRef(true)
  const feedTop = useRef(0)
  useEffect(() => {
    const feed = feedRef.current
    if (feed && atBottom.current) feed.scrollTop = feed.scrollHeight
  }, [chat.items, chat.taskNotes, chat.busy])
  // An earlier page lands above the reader; keep what they were looking at in place.
  const fromBottom = useRef<number>(undefined)
  useLayoutEffect(() => {
    const feed = feedRef.current
    if (!feed || fromBottom.current === undefined) return
    feed.scrollTop = feed.scrollHeight - fromBottom.current
    fromBottom.current = undefined
  }, [chat.items])
  useEffect(() => {
    const feed = feedRef.current
    if (feed && atBottom.current) feed.scrollTop = feed.scrollHeight
  }, [tasks, chat.tasks])
  // Esc closes an open task, as the prototype does.
  useEffect(() => {
    if (!openId) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.dialog, .ctxmenu')) setOpenId(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])

  const say = (text: string) => {
    setFlash(text)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(undefined), 2200)
  }
  const stopTask = (id: string) => onStopTask(id).catch((err: unknown) => say(err instanceof Error ? err.message : String(err)))
  const openTask = (id: string) => {
    setMenu(null)
    setOpenId(id)
    setShow('tasks')
    setBoard(false)
    setTaskNotice(undefined)
  }
  const markDone = (task: ProjectTask) =>
    reviewTask(project.id, task.id).then(
      () => setRefresh(r => r + 1),
      err => say(err instanceof Error ? err.message : String(err)),
    )
  const copyBrief = (task: ProjectTask) =>
    navigator.clipboard.writeText(task.brief).then(
      () => say(t('copied')),
      err => say(err instanceof Error ? err.message : String(err)),
    )

  // ---- the task right-click menu ----
  const openMenu = (e: MouseEvent, task: ProjectTask) => {
    e.preventDefault()
    setMenu({ task, x: e.clientX, y: e.clientY })
  }
  const menuAction = (action: 'open' | 'done' | 'stop' | 'copy') => {
    if (!menu) return
    const task = tasks.find(x => x.id === menu.task.id) ?? menu.task
    setMenu(null)
    if (action === 'open') openTask(task.id)
    else if (action === 'done' && task.state === 'review') void markDone(task)
    else if (action === 'stop' && isLive(task)) void stopTask(task.id)
    else if (action === 'copy' && task.brief) void copyBrief(task)
  }
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    el.style.left = `${Math.min(menu.x, innerWidth - el.offsetWidth - 8)}px`
    el.style.top = `${Math.min(menu.y, innerHeight - el.offsetHeight - 8)}px`
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const click = (e: globalThis.MouseEvent) => {
      if (!e.composedPath().includes(menuRef.current!)) setMenu(null)
    }
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        return setMenu(null)
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const action = ({ o: 'open', d: 'done', s: 'stop', c: 'copy' } as const)[e.key.toLowerCase() as 'o']
      if (!action) return
      e.preventDefault()
      menuAction(action)
    }
    document.addEventListener('click', click)
    addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('click', click)
      removeEventListener('keydown', key, true)
    }
  })

  const card = (task: ProjectTask) => (
    <TaskCard
      key={task.id}
      t={t}
      task={task}
      summary={summaryOf(task)}
      meta={metaOf(task)}
      current={task.id === openId}
      onOpen={() => openTask(task.id)}
      onMenu={e => openMenu(e, task)}
    />
  )
  // An Agent call reads "Handed to <task>" in the chat; before the task is known it is drawn from the call itself.
  const taskCard = (block: Extract<Block, { kind: 'tool' }>) => {
    if (block.name !== 'Agent') return undefined
    const task = byToolUse.get(block.id)
    if (!task) {
      const pending = { id: block.id, title: inputs.get(block.id)?.description ?? '', state: 'running' as const }
      return <TaskLink t={t} task={pending} meta="" activity="" current={false} />
    }
    return (
      <TaskLink
        t={t}
        task={task}
        meta={metaOf(task)}
        activity={summaryOf(task)}
        current={task.id === openId}
        onOpen={() => openTask(task.id)}
        onMenu={e => openMenu(e, task)}
      />
    )
  }

  const seg = (
    <span className="seg pv-seg" role="radiogroup" aria-label={t('pvView')}>
      {(['chat', 'tasks'] as const).map(key => (
        <button type="button" role="radio" key={key} aria-checked={show === key} onClick={() => setShow(key)}>
          {t(key === 'chat' ? 'pvChat' : 'pvTasks')}
        </button>
      ))}
    </span>
  )
  const ib = (label: string, glyph: string, onClick: () => void, enabled = true, wideButton = false) => (
    <button
      type="button"
      className="ib"
      aria-label={label}
      title={label}
      disabled={!enabled}
      onClick={onClick}
      {...(wideButton && { 'data-pv-wide': '' })}
    >
      {glyph}
    </button>
  )
  const wideButton = ib(t(wide ? 'restorePane' : 'expandPane'), wide ? '⤡' : '⤢', () => setWide(!wide), true, true)
  const tools = { ...chatTools(chat, listFiles, prompts, onMode), mode: { mode, plan: chat.env.planMode, onMode } }

  // ---- the splitter between the columns: drag it, or focus it and use ← →. ----
  const clampWidth = (px: number) => {
    const box = viewRef.current?.getBoundingClientRect()
    return box ? Math.max(320, Math.min(box.width - 360, px)) : px
  }
  const setKeptWidth = (px: number) => {
    setWidth(px)
    writeStored(WIDTH_KEY, px)
  }
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    const view = viewRef.current
    if (!view) return
    const box = view.getBoundingClientRect()
    const handle = e.currentTarget
    handle.classList.add('on')
    handle.setPointerCapture(e.pointerId)
    const move = (ev: globalThis.PointerEvent) => setKeptWidth(clampWidth(ev.clientX - box.left))
    const up = () => {
      handle.classList.remove('on')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }
  const dragKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const current = width ?? viewRef.current?.querySelector<HTMLElement>('.pv-chat')?.offsetWidth ?? 0
    setKeptWidth(clampWidth(current + (e.key === 'ArrowLeft' ? -24 : 24)))
  }

  const sendTask = async (task: ProjectTask) => {
    const text = (taskDrafts[task.id] ?? '').trim()
    const pending = taskFiles[task.id] ?? []
    if ((!text && !pending.length) || !canMessage(task)) return
    try {
      const mentions = await Promise.all(pending.map(async f => mentionPath((await uploadFile(uploadTo, f)).path)))
      setTaskDrafts(d => ({ ...d, [task.id]: '' }))
      setTaskFiles(f => ({ ...f, [task.id]: [] }))
      setTaskNotice(undefined)
      const pick = isLive(task) ? {} : (picks[task.id] ?? {})
      say(await onSendTask(task.id, [text, mentions.join(' ')].filter(Boolean).join('\n\n'), pick))
      setFollowUntil(Date.now() + 30_000)
      setRefresh(r => r + 1)
    } catch (err) {
      setTaskNotice(err instanceof Error ? err.message : String(err))
    }
  }

  const coordinatorApprovals = chat.approvals.filter(a => !a.agentId)
  const approval = coordinatorApprovals[0]
  const head = (
    <div className="pv-head">
      {menuButton}
      <b>{project.name}</b>
      <span className="chip">
        {running + blocked > 0 || chat.busy ? (
          <>
            <span className="dot running" />
            {t('coordinating')}
          </>
        ) : (
          t('coordinatorIdle')
        )}
      </span>
      <span className="chip mono">{tilde(project.cwd)}</span>
      <span className="sp" />
      {seg}
      {ib(t('projectSettings'), '⚙', onSettings)}
    </div>
  )

  const sideList = (
    <>
      <div className="pv-head">
        {menuButton}
        <div className="pv-crumb">
          <button type="button" onClick={() => setOpenId(undefined)}>
            {t('pvTasks')}
          </button>
          <span>
            {t('taskCount', { n: String(tasks.length + moved.length) })}
            {running > 0 && t('taskRunningCount', { n: String(running) })}
          </span>
        </div>
        <span className="sp" />
        {seg}
        {ib(t('taskBoard'), '▦', () => setBoard(true))}
        {wideButton}
      </div>
      <div className="pjlist">
        {TASK_GROUPS.map(group => {
          const list = tasks.filter(x => group.states.includes(x.state))
          return list.length ? (
            <Fragment key={group.key}>
              <div className="grp-h">{t(group.key)}</div>
              {list.map(x => card(x))}
            </Fragment>
          ) : null
        })}
        {moved.length > 0 && (
          <>
            <div className="grp-h">{t('taskMovedGroup')}</div>
            {moved.map(entry => (
              <TaskCard
                key={entry.id}
                t={t}
                task={{ id: entry.id, title: entry.title, state: 'done' }}
                summary={t('taskMovedIn')}
                meta={tilde(entry.cwd ?? '')}
                current={false}
                onOpen={() => onOpenSession(entry)}
              />
            ))}
          </>
        )}
        {!tasks.length && !moved.length && <p className="note">{t('noTasks')}</p>}
      </div>
    </>
  )

  const taskHead = (task: ProjectTask) => (
    <div className="pv-head">
      {menuButton}
      <div className="pv-crumb">
        <button type="button" onClick={() => setOpenId(undefined)}>
          {t('pvTasks')}
        </button>
        <span aria-hidden="true">›</span>
        <span>{task.title}</span>
      </div>
      <span className="sp" />
      {seg}
      {ib(t('markDone'), '✓', () => void markDone(task), task.state === 'review')}
      {ib(t('stop'), '■', () => void stopTask(task.id), isLive(task))}
      {wideButton}
      {ib(t('close'), '✕', () => setOpenId(undefined))}
    </div>
  )

  const noteText = (note: TaskNote) => {
    // A coordinator that is no longer running replays no task lines; the table still has the title.
    const row = tasks.find(x => x.id === note.taskId)
    const { key, vars } = taskNoteText(note, chat.tasks[note.taskId] ?? (row && { description: row.title, durationMs: row.duration_ms }))
    return t(key, vars)
  }
  // A task notice under a message ends its turn there.
  const feed = joinTurns(chat.items, id => notes.has(id)).map(({ item, ids }) => (
    <Fragment key={item.id}>
      <Message
        item={item}
        t={t}
        fallbackModel={chatModel}
        models={models}
        streaming={chat.busy && ids.includes(chat.streamingId ?? '')}
        role={item.kind === 'assistant' ? t('coordinatorRole') : undefined}
        taskCard={taskCard}
      />
      {notes.get(ids.at(-1)!)?.map(note => <Note key={`${note.taskId}-${note.n}`} text={noteText(note)} />)}
    </Fragment>
  ))

  const lanes = TASK_LANES.map(({ key, states }) => {
    const list = tasks.filter(x => (states as readonly TaskState[]).includes(x.state))
    return (
      <div className="lane" key={key}>
        <h3>
          {t(key)}
          <span className="note">{list.length}</span>
        </h3>
        {list.length ? (
          list.map(x => (
            <button
              type="button"
              className="wcard"
              key={x.id}
              data-task={x.id}
              onClick={() => openTask(x.id)}
              onContextMenu={e => openMenu(e, x)}
            >
              <b>{x.title}</b>
              <span>{summaryOf(x)}</span>
              <span className="mono">{metaOf(x)}</span>
            </button>
          ))
        ) : (
          <p>—</p>
        )}
      </div>
    )
  })

  const menuTask = menu && (tasks.find(x => x.id === menu.task.id) ?? menu.task)
  const menuItem = (action: 'open' | 'done' | 'stop' | 'copy', ico: string, label: string, key: string, enabled = true) => (
    <button type="button" className="mi" role="menuitem" disabled={!enabled} onClick={() => menuAction(action)}>
      <span className="ico">{ico}</span>
      {label}
      <kbd>{key}</kbd>
    </button>
  )

  return (
    <section
      ref={viewRef}
      className={`projview${wide ? ' wide' : ''}`}
      id="projview"
      data-show={show}
      aria-label={t('projectsSection')}
      style={width ? ({ '--pvl': `${width}px` } as CSSProperties) : undefined}
    >
      <div
        className="pv-chat"
        onDragOver={(e: DragEvent) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e: DragEvent) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          setFiles([...files, ...e.dataTransfer.files])
        }}
      >
        {head}
        <div
          className="feed"
          ref={feedRef}
          aria-busy={chat.busy}
          onScroll={e => (atBottom.current = followScroll(e.currentTarget, atBottom.current, feedTop))}
        >
          {chat.start > 0 && onLoadEarlier && (
            <div className="older-sentinel">
              <button
                type="button"
                onClick={() => {
                  const feed = feedRef.current
                  if (feed) fromBottom.current = feed.scrollHeight - feed.scrollTop
                  onLoadEarlier()
                }}
              >
                {t('loadEarlier')}
              </button>
            </div>
          )}
          {feed}
          {chat.queued.map(item => (
            <Message key={item.id} item={item} t={t} streaming={false} queued />
          ))}
          {notes.get('')?.map(note => <Note key={`${note.taskId}-${note.n}`} text={noteText(note)} />)}
          {(chat.busy || running + blocked > 0) && (
            <div className="status-line" role="status">
              <span className="glyph">✻</span>
              <span className="verb shimmer">Coordinating…</span>
              {running + blocked > 0 && (
                <span>
                  {t('waitingTasks', { n: String(running + blocked) })}
                  {blocked > 0 && t('waitingApprovals', { n: String(blocked) })}
                </span>
              )}
            </div>
          )}
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
          {approval && (
            <AskDock
              approval={approval}
              more={coordinatorApprovals.length - 1}
              cwd={chat.cwd ?? chat.workDir}
              t={t}
              onAnswer={choice => onAnswer(approval, choice)}
            />
          )}
          <ChatComposer
            t={t}
            busy={chat.busy}
            disabled={chat.mode === 'elsewhere'}
            signedOut={signedOut}
            draft={draft}
            setDraft={setDraft}
            onSend={() => {
              atBottom.current = true
              onSend()
            }}
            onStop={onStop}
            onFocus={onFocus}
            files={files}
            setFiles={setFiles}
            placeholder={t('coordinatorPlaceholder')}
            tools={{
              ...tools,
              prompts,
              model: { model: chatModel, effort: chatEffort, models, onModel, onEffort },
            }}
          />
        </div>
      </div>
      <aside className="pv-side" aria-label={t('pvTasks')}>
        <div
          className="pv-drag"
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('dragResize')}
          aria-valuenow={width}
          onPointerDown={drag}
          onKeyDown={dragKey}
        />
        {open ? (
          <TaskPane
            key={open.id}
            t={t}
            project={project}
            task={open}
            model={modelOf(open)}
            effort={picks[open.id]?.effort ?? open.effort ?? chatEffort}
            models={models}
            head={taskHead(open)}
            approvals={chat.approvals.filter(a => a.agentId === open.id)}
            tools={tools}
            signedOut={signedOut}
            draft={taskDrafts[open.id] ?? ''}
            setDraft={v => setTaskDrafts(d => ({ ...d, [open.id]: v }))}
            files={taskFiles[open.id] ?? []}
            setFiles={next => setTaskFiles(f => ({ ...f, [open.id]: next }))}
            notice={taskNotice}
            followUntil={followUntil}
            meta={metaOf(open)}
            pick={picks[open.id] ?? {}}
            onPick={pick => setPicks(p => ({ ...p, [open.id]: pick }))}
            onSend={() => void sendTask(open)}
            onAnswer={onAnswer}
          />
        ) : (
          sideList
        )}
      </aside>
      {board && (
        <Dialog t={t} title={t('taskBoardTitle')} xl onClose={() => setBoard(false)}>
          <div className="lanes wfd-lanes">{lanes}</div>
        </Dialog>
      )}
      {menu &&
        menuTask &&
        createPortal(
          <div ref={menuRef} className="pop ctxmenu" role="menu" aria-label={t('taskMenu')}>
            {menuItem('open', '↗', t('taskOpen'), 'O')}
            {menuItem('done', '✓', t('markDone'), 'D', menuTask.state === 'review')}
            {menuItem('stop', '■', t('stop'), 'S', isLive(menuTask))}
            <hr />
            {menuItem('copy', '⧉', t('copyBrief'), 'C', !!menuTask.brief)}
          </div>,
          document.body,
        )}
      {flash &&
        createPortal(
          <div className="flash" role="status" aria-live="polite">
            {flash}
          </div>,
          document.body,
        )}
    </section>
  )
}

function Note({ text }: { text: string }) {
  return (
    <div className="pj-note">
      <span className="g">↳</span>
      <span>{text}</span>
    </div>
  )
}
