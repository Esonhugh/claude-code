import { type CSSProperties, type DragEvent, Fragment, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTask } from '../agents'
import type { Project } from '../api'
import { mentionPath, tilde, uploadFile } from '../files'
import { agentInputs, notesByItem, projectTasks, TASK_GROUPS, taskMeta, taskNoteText, type TaskState, taskState } from '../projects'
import type { Approval, ApprovalChoice, Block, ModelOption, TaskNote } from '../protocol'
import type { SessionChat } from '../store'
import { AskDock, InputBox, ModeButton, ModelMenu, modelButtonLabel } from './Composer'
import { Dialog } from './Dialog'
import { Message, modelName } from './Message'
import { WORKER_MODELS } from './ProjectDialog'
import { FootMenu, type T } from './ui'

type Show = 'chat' | 'tasks'

function TaskCard({
  t,
  task,
  state,
  meta,
  mini,
  current,
  onOpen,
}: {
  t: T
  task: Pick<AgentTask, 'id' | 'description' | 'summary'>
  state: TaskState
  meta: string
  mini?: boolean
  current: boolean
  onOpen: () => void
}) {
  return (
    <button type="button" className={`pjcard${mini ? ' mini' : ''}`} aria-current={current} onClick={onOpen}>
      <span className={`dot ${state === 'done' ? '' : state}`} />
      <span className="tt">{task.description}</span>
      <span className={`pjbadge ${state}`}>{t(`taskState_${state}`)}</span>
      <span className="sm">{task.summary ?? ''}</span>
      <span className="mt">{meta}</span>
    </button>
  )
}

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
  uploadTo,
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
  onStopTask: (taskId: string) => void
  onSendTask: (taskId: string, text: string) => Promise<string>
  /** The coordinator's session id: task attachments are uploaded there. */
  uploadTo: string
}) {
  const [show, setShow] = useState<Show>('chat')
  const [wide, setWide] = useState(false)
  const [width, setWidth] = useState<number>()
  const [openId, setOpenId] = useState<string>()
  const [reviewed, setReviewed] = useState<ReadonlySet<string>>(new Set())
  const [board, setBoard] = useState(false)
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({})
  const [taskFiles, setTaskFiles] = useState<Record<string, File[]>>({})
  const [taskNotice, setTaskNotice] = useState<string>()
  const feedRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<HTMLElement>(null)

  const tasks = useMemo(() => projectTasks(chat.tasks), [chat.tasks])
  const inputs = useMemo(() => agentInputs(chat.items), [chat.items])
  const notes = useMemo(() => notesByItem(chat.taskNotes, chat.items), [chat.taskNotes, chat.items])
  const byToolUse = useMemo(() => new Map(tasks.filter(x => x.toolUseId).map(x => [x.toolUseId!, x])), [tasks])
  const stateOf = (task: AgentTask) => taskState(task, reviewed)
  const workerModel =
    WORKER_MODELS.find(m => m.value && m.value === project.worker_model)?.label ??
    modelName(chat.model, models) ??
    project.worker_model ??
    undefined
  const mode = chat.permissionMode ?? project.permission_mode
  const running = tasks.filter(x => stateOf(x) === 'running').length
  const blocked = tasks.filter(x => stateOf(x) === 'blocked').length
  const open = openId ? tasks.find(x => x.id === openId) : undefined

  useEffect(() => {
    const feed = feedRef.current
    if (feed) feed.scrollTop = feed.scrollHeight
  }, [chat.items, chat.taskNotes, chat.busy])
  // Esc closes an open task, as the prototype does.
  useEffect(() => {
    if (!openId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.dialog')) setOpenId(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])

  const openTask = (id: string) => {
    setOpenId(id)
    setShow('tasks')
    setBoard(false)
  }
  const card = (task: AgentTask, mini?: boolean) => (
    <TaskCard
      key={task.id}
      t={t}
      task={task}
      state={stateOf(task)}
      meta={taskMeta(task, stateOf(task), workerModel)}
      mini={mini}
      current={task.id === openId}
      onOpen={() => openTask(task.id)}
    />
  )
  // An Agent call is its task's card; before `task_started` arrives it is drawn from the call itself.
  const taskCard = (block: Extract<Block, { kind: 'tool' }>) => {
    if (block.name !== 'Agent') return undefined
    const task = byToolUse.get(block.id)
    if (task) return card(task, true)
    const pending = { id: block.id, description: inputs.get(block.id)?.description ?? '' }
    return <TaskCard t={t} task={pending} state="running" meta="" mini current={false} onOpen={() => {}} />
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
  const modeButton = <ModeButton t={t} mode={mode} onMode={onMode} />

  const drag = (e: PointerEvent<HTMLDivElement>) => {
    const view = viewRef.current
    if (!view) return
    const box = view.getBoundingClientRect()
    const handle = e.currentTarget
    handle.classList.add('on')
    handle.setPointerCapture(e.pointerId)
    const move = (ev: globalThis.PointerEvent) =>
      setWidth(Math.max(320, Math.min(box.width - 360, ev.clientX - box.left)))
    const up = () => {
      handle.classList.remove('on')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  const sendTask = async (task: AgentTask) => {
    const text = (taskDrafts[task.id] ?? '').trim()
    const pending = taskFiles[task.id] ?? []
    if (!text && !pending.length) return
    try {
      const mentions = await Promise.all(pending.map(async f => mentionPath((await uploadFile(uploadTo, f)).path)))
      setTaskDrafts(d => ({ ...d, [task.id]: '' }))
      setTaskFiles(f => ({ ...f, [task.id]: [] }))
      setTaskNotice(await onSendTask(task.id, [text, mentions.join(' ')].filter(Boolean).join('\n\n')))
    } catch (err) {
      setTaskNotice(err instanceof Error ? err.message : String(err))
    }
  }

  const approval = chat.approvals[0]
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
            {t('taskCount', { n: String(tasks.length) })}
            {running > 0 && t('taskRunningCount', { n: String(running) })}
          </span>
        </div>
        <span className="sp" />
        {seg}
        {ib(t('taskBoard'), '▦', () => setBoard(true))}
        {wideButton}
      </div>
      <div className="pjlist">
        {tasks.length ? (
          TASK_GROUPS.map(group => {
            const list = tasks.filter(x => group.states.includes(stateOf(x)))
            return list.length ? (
              <Fragment key={group.key}>
                <div className="grp-h">{t(group.key)}</div>
                {list.map(x => card(x))}
              </Fragment>
            ) : null
          })
        ) : (
          <p className="note">{t('noTasks')}</p>
        )}
      </div>
    </>
  )

  const taskView = (task: AgentTask) => {
    const state = stateOf(task)
    const live = state === 'running' || state === 'blocked'
    const brief = task.toolUseId ? inputs.get(task.toolUseId)?.prompt : undefined
    return (
      <>
        <div className="pv-head">
          {menuButton}
          <div className="pv-crumb">
            <button type="button" onClick={() => setOpenId(undefined)}>
              {t('pvTasks')}
            </button>
            <span aria-hidden="true">›</span>
            <span>{task.description}</span>
          </div>
          <span className="sp" />
          {seg}
          {ib(t('markDone'), '✓', () => setReviewed(new Set([...reviewed, task.id])), state === 'review')}
          {ib(t('stop'), '■', () => onStopTask(task.id), live)}
          {wideButton}
          {ib(t('close'), '✕', () => setOpenId(undefined))}
        </div>
        <div className="feed">
          <div className="pjcheck">
            <b>{task.description}</b>
            <span className="note">
              <span className={`pjbadge ${state}`}>{t(`taskState_${state}`)}</span>
            </span>
          </div>
          {brief && (
            <div className="msg">
              <span className="who">{t('taskBrief')}</span>
              <div className="pjbrief">{brief}</div>
            </div>
          )}
          {task.summary && (
            <div className="msg">
              <span className="who">
                worker{workerModel && <span className="wm"> ({workerModel})</span>}
              </span>
              <div className="md">
                <p>{task.summary}</p>
              </div>
            </div>
          )}
          {state === 'running' && (
            <div className="status-line">
              <span className="glyph">✻</span>
              <span className="verb shimmer">Working…</span>
              <span className="mono">{taskMeta(task, state, workerModel)}</span>
            </div>
          )}
        </div>
        <div className="composer">
          {taskNotice && (
            <div className="notice" role="status">
              {taskNotice}
            </div>
          )}
          <InputBox
            t={t}
            busy={false}
            disabled={state === 'stopped'}
            signedOut={signedOut}
            draft={taskDrafts[task.id] ?? ''}
            setDraft={v => setTaskDrafts(d => ({ ...d, [task.id]: v }))}
            onSend={() => void sendTask(task)}
            onStop={() => {}}
            files={taskFiles[task.id] ?? []}
            setFiles={next => setTaskFiles(f => ({ ...f, [task.id]: next }))}
            skills={chat.env.skills}
            listFiles={listFiles}
            placeholder={t(state === 'stopped' ? 'taskPhStopped' : live ? 'taskPhRunning' : 'taskPhEnded')}
            crow={
              <>
                {modeButton}
                <FootMenu right label={t('model')} button={`${workerModel ?? t('model')}${chat.effort ? ` · ${chat.effort}` : ''}`}>
                  {() => (
                    <>
                      <div className="mh">{live ? t('taskModelLocked') : t('modelGroup')}</div>
                      {models.map(m => (
                        <button type="button" role="menuitemradio" key={m.value} disabled aria-checked={modelName(m.value, models) === workerModel}>
                          {modelName(m.value, models) ?? m.displayName}
                        </button>
                      ))}
                    </>
                  )}
                </FootMenu>
              </>
            }
          />
        </div>
      </>
    )
  }

  const noteText = (note: TaskNote) => {
    const { key, vars } = taskNoteText(note, chat.tasks[note.taskId])
    return t(key, vars)
  }
  const feed = chat.items.map(item => (
    <Fragment key={item.id}>
      <Message
        item={item}
        t={t}
        fallbackModel={chat.model}
        models={models}
        streaming={chat.busy && item.id === chat.streamingId}
        role={item.kind === 'assistant' ? t('coordinatorRole') : undefined}
        taskCard={taskCard}
      />
      {notes.get(item.id)?.map(note => <Note key={`${note.taskId}-${note.status}`} text={noteText(note)} />)}
    </Fragment>
  ))

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
        <div className="feed" ref={feedRef} aria-busy={chat.busy}>
          {feed}
          {notes.get('')?.map(note => <Note key={`${note.taskId}-${note.status}`} text={noteText(note)} />)}
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
              more={chat.approvals.length - 1}
              cwd={chat.cwd ?? chat.workDir}
              t={t}
              onAnswer={choice => onAnswer(approval, choice)}
            />
          )}
          <InputBox
            t={t}
            busy={chat.busy}
            disabled={chat.mode === 'elsewhere'}
            signedOut={signedOut}
            draft={draft}
            setDraft={setDraft}
            onSend={onSend}
            onStop={onStop}
            onFocus={onFocus}
            files={files}
            setFiles={setFiles}
            commands={chat.commands}
            hiddenCommands={chat.terminalCommands}
            skills={chat.env.skills}
            listFiles={listFiles}
            prompts={prompts}
            placeholder={t('coordinatorPlaceholder')}
            crow={
              <>
                {modeButton}
                {models.length > 0 && (
                  <FootMenu right label={t('model')} button={modelButtonLabel(chat.model, chat.effort, models, t)}>
                    {close => (
                      <ModelMenu
                        t={t}
                        model={chat.model}
                        effort={chat.effort}
                        models={models}
                        onModel={onModel}
                        onEffort={onEffort}
                        close={close}
                      />
                    )}
                  </FootMenu>
                )}
              </>
            }
          />
        </div>
      </div>
      <aside className="pv-side" aria-label={t('pvTasks')}>
        <div className="pv-drag" role="separator" aria-orientation="vertical" aria-label={t('dragResize')} onPointerDown={drag} />
        {open ? taskView(open) : sideList}
      </aside>
      {board && (
        <Dialog t={t} title={t('taskBoardTitle')} xl onClose={() => setBoard(false)}>
          <div className="lanes wfd-lanes">
            {(
              [
                ['groupRunning', ['running']],
                ['taskState_blocked', ['blocked']],
                ['taskState_review', ['review']],
                ['groupEnded', ['done', 'stopped']],
              ] as const
            ).map(([key, states]) => {
              const list = tasks.filter(x => (states as readonly TaskState[]).includes(stateOf(x)))
              return (
                <div className="lane" key={key}>
                  <h3>
                    {t(key)}
                    <span className="note">{list.length}</span>
                  </h3>
                  {list.length ? (
                    list.map(x => (
                      <button type="button" className="wcard" key={x.id} onClick={() => openTask(x.id)}>
                        <b>{x.description}</b>
                        <span>{x.summary ?? ''}</span>
                        <span className="mono">{taskMeta(x, stateOf(x), workerModel)}</span>
                      </button>
                    ))
                  ) : (
                    <p>—</p>
                  )}
                </div>
              )
            })}
          </div>
        </Dialog>
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
