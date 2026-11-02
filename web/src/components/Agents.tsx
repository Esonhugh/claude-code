import { type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  type AgentTask,
  buildTeam,
  canChat,
  currentPhase,
  formatDuration,
  formatTokens,
  groupTasks,
  isFinished,
  parentId,
  type Tasks,
  taskName,
  type Team,
  TEAM_LEAD,
  type TeamMember,
  unresolvedIssuers,
  type WorkflowPhase,
  workflowAgent,
} from '../agents'
import { loadAgentIssuers, loadAgentTranscript } from '../api'
import type { MessageKey } from '../i18n'
import { initialState, type Item, reduce } from '../protocol'
import { Message, TeamDot, teamEventLabel } from './Chat'

type T = (key: MessageKey, vars?: Record<string, string>) => string

const COLLAPSED_KEY = 'claude-web-agents-collapsed'

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    // Finished agents start folded.
    return new Set(raw ? (JSON.parse(raw) as string[]) : ['finished'])
  } catch {
    return new Set(['finished'])
  }
}

function useCollapsed() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const toggle = (key: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      } catch {
        // Per-browser convenience only.
      }
      return next
    })
  return [collapsed, toggle] as const
}

function StatusDot({ status }: { status: string }) {
  return <span className={`agent-dot agent-${status}`} aria-label={status} />
}

function meta(task: AgentTask): string {
  return [
    formatDuration(task.durationMs),
    formatTokens(task.tokens),
    !isFinished(task) && task.lastTool,
  ]
    .filter(Boolean)
    .join(' · ')
}

function Caret({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className="ghost caret"
      aria-expanded={open}
      aria-label={label}
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
    >
      {open ? '▾' : '▸'}
    </button>
  )
}

function PhaseList({
  task,
  collapsed,
  toggle,
  onOpenAgent,
  t,
}: {
  task: AgentTask
  collapsed: Set<string>
  toggle: (key: string) => void
  onOpenAgent: (workflow: AgentTask, label: string) => void
  t: T
}) {
  return (
    <ul className="agent-children">
      {(task.phases ?? []).map(phase => {
        const key = `${task.id}:phase:${phase.index}`
        const open = !collapsed.has(key)
        const done = phase.agents.filter(a => a.status === 'completed').length
        return (
          <li key={phase.index}>
            <div className="agent-row phase-row">
              <Caret open={open} onClick={() => toggle(key)} label={phase.label} />
              <StatusDot status={phase.status} />
              <span className="agent-name">{phase.label}</span>
              <span className="agent-desc">{phase.message}</span>
              <span className="agent-meta">
                {t('phaseAgents', { done: String(done), total: String(phase.agents.length) })}
              </span>
            </div>
            {open && (
              <ul className="agent-children">
                {phase.agents.map(agent => (
                  <li key={agent.label}>
                    <button
                      type="button"
                      className="agent-row agent-leaf"
                      onClick={() => onOpenAgent(task, agent.label)}
                    >
                      <StatusDot status={agent.status} />
                      <span className="agent-name">{agent.label}</span>
                      <span className="agent-meta">{agent.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function TaskRow({
  task,
  level = 0,
  subtasks,
  collapsed,
  toggle,
  onOpen,
  onOpenAgent,
  onStop,
  t,
}: {
  task: AgentTask
  level?: number
  /** Subagents by the agent that started them. */
  subtasks: Map<string, AgentTask[]>
  collapsed: Set<string>
  toggle: (key: string) => void
  onOpen: (task: AgentTask) => void
  onOpenAgent: (workflow: AgentTask, label: string) => void
  onStop: (taskId: string) => void
  t: T
}) {
  const hasPhases = !!task.phases?.length
  const children = subtasks.get(task.id) ?? []
  const foldable = hasPhases || children.length > 0
  const open = foldable && !collapsed.has(task.id)
  return (
    <li>
      <div
        className="agent-row"
        role="button"
        tabIndex={0}
        style={{ paddingLeft: `${8 + level * 14}px` }}
        onClick={() => onOpen(task)}
        onKeyDown={e => {
          if (e.key === 'Enter') onOpen(task)
        }}
      >
        {foldable ? (
          <Caret open={open} onClick={() => toggle(task.id)} label={taskName(task)} />
        ) : (
          <span className="caret-space" />
        )}
        <StatusDot status={task.status} />
        <span className="agent-name">{taskName(task)}</span>
        <span className="agent-desc">{task.description}</span>
        <span className="agent-meta">{meta(task)}</span>
        {!isFinished(task) && (
          <button
            type="button"
            className="ghost agent-stop"
            aria-label={t('stopTask', { name: taskName(task) })}
            onClick={e => {
              e.stopPropagation()
              onStop(task.id)
            }}
          >
            ■
          </button>
        )}
      </div>
      {open && hasPhases && (
        <PhaseList
          task={task}
          collapsed={collapsed}
          toggle={toggle}
          onOpenAgent={onOpenAgent}
          t={t}
        />
      )}
      {open && children.length > 0 && (
        <ul className="agent-tree">
          {children.map(child => (
            <TaskRow
              key={child.id}
              task={child}
              level={level + 1}
              subtasks={subtasks}
              collapsed={collapsed}
              toggle={toggle}
              onOpen={onOpen}
              onOpenAgent={onOpenAgent}
              onStop={onStop}
              t={t}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

const IDLE_FOLD = 3

function MemberRow({
  member,
  onOpen,
  t,
}: {
  member: TeamMember
  onOpen: (taskId: string) => void
  t: T
}) {
  const state =
    member.state === 'working'
      ? t('memberWorking')
      : member.state === 'idle'
        ? t('teamIdle')
        : t('memberStopped')
  return (
    <li>
      <button
        type="button"
        className={`agent-row agent-leaf member-${member.state}`}
        onClick={() => onOpen(member.task.id)}
      >
        <TeamDot color={member.color} />
        <span className="agent-name">{member.name}</span>
        <span className="agent-desc">{member.task.description}</span>
        <span className="agent-meta">{[state, meta(member.task)].filter(Boolean).join(' · ')}</span>
      </button>
    </li>
  )
}

/** The team group: members (idle ones folded past three, as in the TUI) and its messages. */
function TeamSection({
  team,
  collapsed,
  toggle,
  onOpenMember,
  onOpenMessages,
  t,
}: {
  team: Team
  collapsed: Set<string>
  toggle: (key: string) => void
  onOpenMember: (taskId: string) => void
  onOpenMessages: () => void
  t: T
}) {
  const open = !collapsed.has('team')
  const working = team.members.filter(m => m.state === 'working')
  const idle = team.members.filter(m => m.state === 'idle')
  const stopped = team.members.filter(m => m.state === 'stopped')
  // Folded unless the user opened it; the key records the opposite of the default.
  const idleOpen = idle.length <= IDLE_FOLD || collapsed.has('team:idle')
  const row = (member: TeamMember) => (
    <MemberRow key={member.task.id} member={member} onOpen={onOpenMember} t={t} />
  )
  return (
    <section className="agent-section">
      <button
        type="button"
        className="ghost agent-section-head"
        aria-expanded={open}
        onClick={() => toggle('team')}
      >
        {open ? '▾' : '▸'} {t('team')} ·{' '}
        {t('teamSummary', { working: String(working.length), idle: String(idle.length) })}
      </button>
      {open && (
        <ul className="agent-tree">
          {working.map(row)}
          {idleOpen ? (
            idle.map(row)
          ) : (
            <li>
              <button type="button" className="agent-row agent-leaf" onClick={() => toggle('team:idle')}>
                <span className="caret-space" />
                <span className="agent-desc">{t('idleAgents', { n: String(idle.length) })}</span>
              </button>
            </li>
          )}
          {stopped.map(row)}
          <li>
            <button type="button" className="agent-row agent-leaf" onClick={onOpenMessages}>
              <span className="caret-space" />
              <span className="agent-name">{t('teamMessages')}</span>
              <span className="agent-meta">{team.events.length}</span>
            </button>
          </li>
        </ul>
      )}
    </section>
  )
}

/** Lead and teammate messages in order, like a group chat. */
function TeamTimeline({ team, t }: { team: Team; t: T }) {
  const colors = new Map(team.members.map(m => [m.name, m.color]))
  if (!team.events.length) return <div className="preview-note">{t('noTeamMessages')}</div>
  return (
    <ul className="team-timeline">
      {team.events.map(event => {
        const label = teamEventLabel(event.type, t)
        return (
          <li key={event.id} className={event.from === TEAM_LEAD ? 'team-from-lead' : undefined}>
            <div className="team-route">
              <TeamDot color={event.color ?? colors.get(event.from)} />
              <strong>{event.from}</strong>
              <span>→ {event.to}</span>
              {label && <span className="team-event">{label}</span>}
            </div>
            {event.text && <div className="team-text">{event.text}</div>}
          </li>
        )
      })}
    </ul>
  )
}

function Section({
  id,
  title,
  tasks,
  collapsed,
  toggle,
  children,
}: {
  id: string
  title: string
  tasks: AgentTask[]
  collapsed: Set<string>
  toggle: (key: string) => void
  children: (task: AgentTask) => ReactNode
}) {
  if (!tasks.length) return null
  const open = !collapsed.has(id)
  return (
    <section className="agent-section">
      <button
        type="button"
        className="ghost agent-section-head"
        aria-expanded={open}
        onClick={() => toggle(id)}
      >
        {open ? '▾' : '▸'} {title} · {tasks.length}
      </button>
      {open && <ul className="agent-tree">{tasks.map(children)}</ul>}
    </section>
  )
}

function WorkflowLanes({
  phases,
  onOpenAgent,
}: {
  phases: WorkflowPhase[]
  onOpenAgent: (label: string) => void
}) {
  const current = currentPhase(phases)
  return (
    <div className="lanes">
      {phases.map((phase, i) => (
        <div key={phase.index} className={`lane${i === current ? ' lane-current' : ''}`}>
          <div className="lane-head">
            <StatusDot status={phase.status} />
            <strong>{phase.label}</strong>
            <small>
              {phase.agents.filter(a => a.status === 'completed').length}/{phase.agents.length}
            </small>
          </div>
          {phase.message && <div className="lane-desc">{phase.message}</div>}
          {phase.agents.map(agent => (
            <button
              type="button"
              key={agent.label}
              className={`lane-card agent-${agent.status}`}
              onClick={() => onOpenAgent(agent.label)}
            >
              <StatusDot status={agent.status} />
              <span>{agent.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function WorkflowView({
  task,
  onOpenAgent,
  onStop,
  t,
}: {
  task: AgentTask
  onOpenAgent: (workflow: AgentTask, label: string) => void
  onStop: (taskId: string) => void
  t: T
}) {
  const [expanded, setExpanded] = useState(false)
  const phases = task.phases ?? []
  const current = phases[currentPhase(phases)]
  const allAgents = phases.flatMap(p => p.agents)
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setExpanded(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [expanded])
  return (
    <div className="workflow-view">
      <div className="workflow-line">
        <StatusDot status={task.status} />
        <span>
          {current
            ? t('workflowPhase', {
                n: String(currentPhase(phases) + 1),
                total: String(phases.length),
                name: current.label,
              })
            : task.status}
        </span>
        <span className="agent-meta">
          {t('phaseAgents', {
            done: String(allAgents.filter(a => a.status === 'completed').length),
            total: String(allAgents.length),
          })}
        </span>
        {phases.length > 0 && (
          <button type="button" className="ghost" onClick={() => setExpanded(true)}>
            {t('expand')}
          </button>
        )}
        {!isFinished(task) && (
          <button type="button" className="ghost" onClick={() => onStop(task.id)}>
            {t('stopWorkflow')}
          </button>
        )}
      </div>
      {current && (
        <div className="lane-cards">
          {current.agents.map(agent => (
            <button
              type="button"
              key={agent.label}
              className={`lane-card agent-${agent.status}`}
              onClick={() => onOpenAgent(task, agent.label)}
            >
              <StatusDot status={agent.status} />
              <span>{agent.label}</span>
            </button>
          ))}
        </div>
      )}
      {task.summary && <div className="agent-summary">{task.summary}</div>}
      {expanded && (
        <div className="modal-scrim" onClick={() => setExpanded(false)}>
          <div
            className="modal"
            role="dialog"
            aria-label={taskName(task)}
            onClick={e => e.stopPropagation()}
          >
            <div className="modal-head">
              <strong>{taskName(task)}</strong>
              <span className="agent-desc">{task.description}</span>
              <span className="agent-meta">{meta(task)}</span>
              <button
                type="button"
                className="ghost"
                aria-label={t('close')}
                onClick={() => setExpanded(false)}
              >
                ×
              </button>
            </div>
            <WorkflowLanes
              phases={phases}
              onOpenAgent={label => {
                setExpanded(false)
                onOpenAgent(task, label)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function AgentView({
  sessionId,
  agentId,
  task,
  name,
  onSend,
  t,
}: {
  sessionId: string
  agentId: string
  task?: AgentTask
  /** Shown in the input's placeholder; defaults to the task's name. */
  name?: string
  onSend?: (text: string) => Promise<string>
  t: T
}) {
  const [messages, setMessages] = useState<unknown[]>()
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string>()
  // Refetch whenever the agent reports progress or ends.
  const tick = `${task?.toolUses ?? ''}:${task?.status ?? ''}:${task?.summary ?? ''}`
  // A resumed run reports little, so poll while it runs and for a while after a send.
  const [poll, setPoll] = useState(0)
  const [followUntil, setFollowUntil] = useState(0)
  const running = task !== undefined && !isFinished(task)
  useEffect(() => {
    if (!running && followUntil <= Date.now()) return
    const timer = setInterval(() => {
      if (running || Date.now() < followUntil) setPoll(n => n + 1)
      else clearInterval(timer)
    }, 1500)
    return () => clearInterval(timer)
  }, [running, followUntil])
  useEffect(() => {
    let live = true
    loadAgentTranscript(sessionId, agentId).then(
      page => {
        if (!live) return
        setMessages(page.messages)
        setFailed(false)
      },
      () => live && setFailed(true),
    )
    return () => {
      live = false
    }
  }, [sessionId, agentId, tick, poll])
  const items = useMemo(
    () => (messages ?? []).reduce(reduce, initialState).items,
    [messages],
  )
  const send = async () => {
    const text = draft.trim()
    if (!text || !onSend) return
    setDraft('')
    try {
      setNote(await onSend(text))
      setFollowUntil(Date.now() + 30_000)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }
  const stoppedTeammate =
    task?.type === 'in_process_teammate' && task !== undefined && isFinished(task)
  return (
    <div className="agent-view">
      <div className="agent-feed">
        {failed && !messages && <div className="preview-note">{t('agentNoTranscript')}</div>}
        {!failed && !messages && <div className="preview-note">{t('loading')}</div>}
        {items.map(item => (
          <Message key={item.id} item={item} t={t} streaming={false} />
        ))}
        {task?.outputFile && isFinished(task) && task.summary && (
          <div className="agent-summary">{task.summary}</div>
        )}
      </div>
      {onSend ? (
        <div className="agent-input">
          {note && (
            <div className="preview-note" role="status">
              {note}
            </div>
          )}
          <div className="input-card">
            <textarea
              rows={1}
              value={draft}
              disabled={stoppedTeammate}
              placeholder={
                stoppedTeammate
                  ? t('teammateStopped')
                  : t('sendTo', { name: name ?? (task ? taskName(task) : agentId) })
              }
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button
              type="button"
              className="send"
              aria-label={t('send')}
              disabled={!draft.trim() || stoppedTeammate}
              onClick={() => void send()}
            >
              ↑
            </button>
          </div>
        </div>
      ) : (
        <div className="preview-note">{t('agentReadonly')}</div>
      )}
    </div>
  )
}

export type AgentsView =
  | { kind: 'tree' }
  | { kind: 'task'; id: string }
  | { kind: 'agent'; id: string; name: string }
  | { kind: 'team' }

/** Issuers of the Agent calls made inside subagents, looked up as they appear. */
function useIssuers(sessionId: string, tasks: Tasks): Record<string, string> {
  const [issuers, setIssuers] = useState<Record<string, string>>({})
  const [attempt, setAttempt] = useState(0)
  const pending = unresolvedIssuers(tasks, issuers).join(',')
  useEffect(() => {
    if (!pending) return
    let live = true
    // The issuing transcript may not be flushed yet; retry a few times.
    const retry = attempt < 5 ? setTimeout(() => live && setAttempt(n => n + 1), 2000) : undefined
    loadAgentIssuers(sessionId, pending.split(',')).then(
      found => live && Object.keys(found).length && setIssuers(prev => ({ ...prev, ...found })),
      () => {},
    )
    return () => {
      live = false
      clearTimeout(retry)
    }
  }, [sessionId, pending, attempt])
  return issuers
}

/** Right-hand Agents panel: a collapsible tree, workflow view and agent chat. */
export function AgentsPanel({
  sessionId,
  tasks,
  items,
  busy,
  view,
  setView,
  onStop,
  onSend,
  onClose,
  t,
}: {
  sessionId: string
  tasks: Tasks
  /** The lead's chat, for teammate names and team messages. */
  items: Item[]
  busy: boolean
  view: AgentsView
  setView: (view: AgentsView) => void
  onStop: (taskId: string) => void
  onSend: (taskId: string, text: string) => Promise<string>
  onClose: () => void
  t: T
}) {
  const [collapsed, toggle] = useCollapsed()
  const issuers = useIssuers(sessionId, tasks)
  const groups = groupTasks(tasks, issuers)
  const team = useMemo(() => buildTeam(tasks, items), [tasks, items])
  const openTask = (task: AgentTask) => setView({ kind: 'task', id: task.id })
  const openAgent = (workflow: AgentTask, label: string) => {
    const task = workflowAgent(tasks, workflow, label)
    setView(task ? { kind: 'task', id: task.id } : { kind: 'agent', id: label, name: label })
  }
  const selected = view.kind === 'task' ? tasks[view.id] : undefined
  const member = selected && team?.members.find(m => m.task.id === selected.id)
  const parent = selected && parentId(selected, tasks, issuers)
  const inWorkflow = parent !== undefined && tasks[parent]?.type === 'local_workflow'
  const title =
    view.kind === 'tree'
      ? t('agents')
      : view.kind === 'team'
        ? t('team')
        : member
          ? member.name
          : selected
            ? taskName(selected)
            : view.kind === 'agent'
              ? view.name
              : ''

  useEffect(() => {
    if (view.kind === 'tree') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest('textarea')) {
        setView({ kind: 'tree' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view.kind, setView])

  const row = (task: AgentTask) => (
    <TaskRow
      key={task.id}
      task={task}
      subtasks={groups.children}
      collapsed={collapsed}
      toggle={toggle}
      onOpen={openTask}
      onOpenAgent={openAgent}
      onStop={onStop}
      t={t}
    />
  )

  return (
    <aside className="preview agents" aria-label={t('agents')}>
      <div className="preview-bar">
        {view.kind !== 'tree' && (
          <button
            type="button"
            className="ghost"
            aria-label={t('back')}
            onClick={() => setView({ kind: 'tree' })}
          >
            ‹
          </button>
        )}
        <span className="preview-name">{title}</span>
        {selected && <span className="agent-meta">{meta(selected)}</span>}
        <button type="button" className="ghost" aria-label={t('collapsePanel')} onClick={onClose}>
          »
        </button>
      </div>
      <div className="preview-body">
        {view.kind === 'tree' && (
          <>
            <div className="agent-row agent-root">
              <span className="caret-space" />
              <StatusDot status={busy ? 'running' : 'idle'} />
              <span className="agent-name">{t('mainSession')}</span>
              <span className="agent-meta">{busy ? t('statusLive') : t('idle')}</span>
            </div>
            {!groups.running.length && !groups.finished.length && !team && (
              <div className="preview-note">{t('noAgents')}</div>
            )}
            <Section
              id="running"
              title={t('runningGroup')}
              tasks={groups.running}
              collapsed={collapsed}
              toggle={toggle}
            >
              {row}
            </Section>
            {team && (
              <TeamSection
                team={team}
                collapsed={collapsed}
                toggle={toggle}
                onOpenMember={id => setView({ kind: 'task', id })}
                onOpenMessages={() => setView({ kind: 'team' })}
                t={t}
              />
            )}
            <Section
              id="finished"
              title={t('finishedGroup')}
              tasks={groups.finished}
              collapsed={collapsed}
              toggle={toggle}
            >
              {row}
            </Section>
          </>
        )}
        {selected?.type === 'local_workflow' && (
          <WorkflowView task={selected} onOpenAgent={openAgent} onStop={onStop} t={t} />
        )}
        {selected && selected.type !== 'local_workflow' && (
          <AgentView
            sessionId={sessionId}
            agentId={member?.agentId ?? selected.id}
            task={selected}
            name={member?.name}
            onSend={canChat(selected) && !inWorkflow ? text => onSend(selected.id, text) : undefined}
            t={t}
          />
        )}
        {view.kind === 'team' && team && <TeamTimeline team={team} t={t} />}
        {view.kind === 'task' && !selected && <div className="preview-note">{t('noAgents')}</div>}
        {view.kind === 'agent' && (
          <AgentView sessionId={sessionId} agentId={view.id} t={t} />
        )}
      </div>
    </aside>
  )
}
