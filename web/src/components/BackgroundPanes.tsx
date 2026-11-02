import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AgentTask, formatDuration, type Tasks } from '../agents'
import {
  clockTime,
  type Details,
  groupTasks,
  type Groups,
  isRunning,
  mergeDetails,
  parseScreen,
  type Screen,
  screenTail,
  spanClass,
  statusOf,
  type TaskDetail,
} from '../background'
import { dotClass } from './Agents'
import type { T } from './ui'

export type HostRequest = (body: Record<string, unknown>) => Promise<Record<string, unknown>>

const POLL_MS = 1000

/**
 * Details and terminal screens for the Terminals, Monitor and Background
 * Tasks panes. The listing is fetched whenever the task map changes, and
 * every second while one of those panes is open and something runs there.
 */
export function useBackground(sessionId: string, tasks: Tasks, polling: boolean, request: HostRequest) {
  const [details, setDetails] = useState<Details>({})
  const [screens, setScreens] = useState<Record<string, Screen>>({})
  const requestRef = useRef(request)
  requestRef.current = request

  useEffect(() => {
    setDetails({})
    setScreens({})
  }, [sessionId])

  const refresh = useCallback(() => {
    requestRef.current({ subtype: 'get_background_tasks' }).then(
      body => setDetails(prev => mergeDetails(prev, body)),
      () => {},
    )
  }, [])

  const refreshScreen = useCallback((taskId: string) => {
    requestRef.current({ subtype: 'get_task_output', task_id: taskId, format: 'screen' }).then(body => {
      const screen = parseScreen(body)
      if (screen) setScreens(prev => ({ ...prev, [taskId]: screen }))
    }, () => {})
  }, [])

  const groups = useMemo(() => groupTasks(tasks, details), [tasks, details])
  const signature = Object.values(tasks)
    .filter(task => ['interactive_terminal', 'local_bash', 'monitor_mcp', 'dream'].includes(task.type))
    .map(task => `${task.id}:${task.status}`)
    .join(',')
  useEffect(() => {
    if (signature) refresh()
  }, [signature, sessionId, refresh])

  const anyRunning = [...groups.terminals, ...groups.monitors, ...groups.background].some(task =>
    isRunning(task, details[task.id]),
  )
  useEffect(() => {
    if (!polling || !anyRunning) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [polling, anyRunning, refresh])

  return { details, screens, groups, refreshScreen }
}

/** Who started a task: the main session or the agent with that id. */
function startedBy(t: T, tasks: Tasks, detail?: TaskDetail): string {
  const agent = detail?.agentId ? tasks[detail.agentId] : undefined
  if (!detail?.agentId) return t('mainSession')
  return agent?.subagentType ?? agent?.description ?? detail.agentId
}

const selectedStyle = { background: 'var(--sunken)' }

function useSelected(list: AgentTask[]): [string | undefined, (id: string) => void] {
  const [selected, setSelected] = useState<string>()
  const current = list.some(task => task.id === selected) ? selected : list[0]?.id
  return [current, setSelected]
}

export function TerminalsPane({
  t,
  tasks,
  groups,
  details,
  screens,
  refreshScreen,
  request,
  onStop,
}: {
  t: T
  tasks: Tasks
  groups: Groups
  details: Details
  screens: Record<string, Screen>
  refreshScreen: (taskId: string) => void
  request: HostRequest
  onStop: (id: string) => void
}) {
  const list = groups.terminals
  const [openId, setOpenId] = useSelected(list)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string>()
  const open = list.find(task => task.id === openId)
  const running = open ? isRunning(open, details[open.id]) : false

  useEffect(() => {
    if (!openId) return
    refreshScreen(openId)
    if (!running) return
    const timer = setInterval(() => refreshScreen(openId), POLL_MS)
    return () => clearInterval(timer)
  }, [openId, running, refreshScreen])

  if (!list.length || !open) return <p className="note">{t('noTerminals')}</p>

  const send = (keys: { text?: string; key?: string; enter?: boolean }) => {
    setError(undefined)
    request({ subtype: 'send_terminal_input', task_id: open.id, ...keys }).then(
      () => refreshScreen(open.id),
      e => setError(e instanceof Error ? e.message : String(e)),
    )
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    send(input ? { text: input, enter: true } : { enter: true })
    setInput('')
  }
  const screen = screens[open.id]
  return (
    <>
      <div className="tree">
        {list.map(task => {
          const detail = details[task.id]
          const status = statusOf(task, detail)
          const meta = [
            t('termOpened', { by: startedBy(t, tasks, detail) }),
            detail?.cols && detail.rows && `${detail.cols}×${detail.rows}`,
            detail?.exitCode !== undefined && `exit ${detail.exitCode}`,
          ]
          return (
            <button
              className="node"
              type="button"
              key={task.id}
              style={task.id === open.id ? selectedStyle : undefined}
              onClick={() => setOpenId(task.id)}
            >
              <span className="lead">
                <span className={`dot ${dotClass(status)}`} />
              </span>
              <span className="name mono">{detail?.command ?? task.description}</span>
              <span className={`badge ${dotClass(status)}`}>{status}</span>
              <span className="meta2">{meta.filter(Boolean).join(' · ')}</span>
            </button>
          )
        })}
      </div>
      <pre className="screen" aria-label={t('termScreen')}>
        {screen &&
          screenTail(screen).map((line, row) => (
            <span key={row}>
              {row > 0 && '\n'}
              {line.map((span, i) =>
                spanClass(span) ? (
                  <span key={i} className={spanClass(span)}>
                    {span.text}
                  </span>
                ) : (
                  span.text
                ),
              )}
            </span>
          ))}
      </pre>
      {running && (
        <form className="term-input" onSubmit={submit}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={t('termInput')}
            aria-label={t('termInput')}
            className="mono"
          />
          <button className="btn" type="button" onClick={() => send({ key: 'CTRL_C' })}>
            Ctrl+C
          </button>
        </form>
      )}
      {error && <p className="note">{error}</p>}
      <div className="btns">
        {running && (
          <button className="btn" type="button" onClick={() => onStop(open.id)}>
            {t('stop')}
          </button>
        )}
      </div>
    </>
  )
}

export function MonitorPane({
  t,
  tasks,
  groups,
  details,
  onStop,
}: {
  t: T
  tasks: Tasks
  groups: Groups
  details: Details
  onStop: (id: string) => void
}) {
  const list = groups.monitors
  const [openId, setOpenId] = useSelected(list)
  const open = list.find(task => task.id === openId)
  if (!list.length || !open) return <p className="note">{t('noMonitors')}</p>
  const openDetail = details[open.id]
  return (
    <>
      <div className="tree">
        {list.map(task => {
          const detail = details[task.id]
          const status = statusOf(task, detail)
          const meta = [
            startedBy(t, tasks, detail),
            formatDuration(detail?.durationMs),
            t('nEvents', { n: String(detail?.events?.length ?? 0) }),
          ]
          return (
            <button
              className="node"
              type="button"
              key={task.id}
              style={task.id === open.id ? selectedStyle : undefined}
              onClick={() => setOpenId(task.id)}
            >
              <span className="lead">
                <span className={`dot ${dotClass(status)}`} />
              </span>
              <span className="name">
                <b>{task.description}</b>
              </span>
              <span className={`badge ${dotClass(status)}`}>{status}</span>
              <span className="meta2">{meta.filter(Boolean).join(' · ')}</span>
            </button>
          )
        })}
      </div>
      <div className="fprev">
        <div className="fhead">
          <b className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
            {openDetail?.command ?? open.description}
          </b>
          {isRunning(open, openDetail) && (
            <button className="btn" type="button" onClick={() => onStop(open.id)}>
              {t('stop')}
            </button>
          )}
        </div>
        <div className="events">
          {(openDetail?.events ?? [])
            .slice()
            .reverse()
            .map((event, i) => (
              <div key={i}>
                <span className="mono note">{clockTime(event.time)}</span>
                <span>{event.text}</span>
              </div>
            ))}
        </div>
      </div>
    </>
  )
}

export function BackgroundPane({
  t,
  tasks,
  groups,
  details,
  onStop,
}: {
  t: T
  tasks: Tasks
  groups: Groups
  details: Details
  onStop: (id: string) => void
}) {
  const list = groups.background
  if (!list.length) return <p className="note">{t('noBackground')}</p>
  return (
    <div className="tree">
      {list.map(task => {
        const detail = details[task.id]
        const status = statusOf(task, detail)
        const running = isRunning(task, detail)
        const tail = [detail?.exitCode !== undefined && !running && `exit ${detail.exitCode}`, detail?.tail]
          .filter(Boolean)
          .join(' · ')
        const meta = [startedBy(t, tasks, detail), formatDuration(detail?.durationMs), tail]
        return (
          <div className="node bgrow" key={task.id}>
            <span className="lead">
              <span className={`dot ${dotClass(status)}`} />
            </span>
            <span className="name">
              <span className="tag">{task.type === 'dream' ? 'Dream' : 'Bash'}</span>{' '}
              <span className="mono">{detail?.command ?? task.description}</span>
            </span>
            <span className={`badge ${dotClass(status)}`}>{status}</span>
            <span className="meta2">{meta.filter(Boolean).join(' · ')}</span>
            {running && (
              <span className="bgact">
                <button className="btn" type="button" onClick={() => onStop(task.id)}>
                  {t('stop')}
                </button>
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
