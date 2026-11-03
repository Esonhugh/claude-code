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
import { initialState, type Item, reduce } from '../protocol'
import { Dialog } from './Dialog'
import { joinTurns, Message, TeamDot, teamEventLabel } from './Message'
import type { T } from './ui'

const COLLAPSED_KEY = 'claude-web-agents-collapsed'

/** Task types the Agents tab shows; shells, terminals and monitors have their own tabs. */
export const AGENT_TYPES = new Set(['local_agent', 'remote_agent', 'local_workflow', 'in_process_teammate'])

export function agentTasks(tasks: Tasks): Tasks {
  return Object.fromEntries(Object.entries(tasks).filter(([, task]) => AGENT_TYPES.has(task.type)))
}

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

/** `.dot` classes the prototype styles: running, idle, failed, killed, pending. */
export function dotClass(status: string): string {
  return status === 'stopped' ? 'killed' : status
}

export function statusText(status: string, t: T): string {
  return status === 'killed' || status === 'stopped' ? t('statusKilled') : status
}

export function taskMeta(task: AgentTask): string {
  return [formatDuration(task.durationMs), formatTokens(task.tokens), !isFinished(task) && task.lastTool]
    .filter(Boolean)
    .join(' · ')
}

/** One `.node` row: lead, name and description, status badge, meta line. */
export function Node({
  lead,
  name,
  desc,
  badge,
  badgeClass = '',
  meta,
  className = '',
  onOpen,
  onStop,
  stopLabel,
}: {
  lead: ReactNode
  name: ReactNode
  desc?: string
  badge?: string
  badgeClass?: string
  meta?: string
  className?: string
  onOpen?: () => void
  onStop?: () => void
  stopLabel?: string
}) {
  return (
    <div
      className={`node agent-row ${className}`.trim()}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen?.()
      }}
    >
      <span className="lead">{lead}</span>
      <span className="name">
        <b>{name}</b>
        {desc && <span>{desc}</span>}
      </span>
      {onStop && (
        <button
          type="button"
          className="stop"
          aria-label={stopLabel}
          onClick={e => {
            e.stopPropagation()
            onStop()
          }}
        >
          ■
        </button>
      )}
      {badge && <span className={`badge ${badgeClass}`.trim()}>{badge}</span>}
      {meta && <span className="meta2">{meta}</span>}
    </div>
  )
}

function TaskNode({
  task,
  subtasks,
  collapsed,
  toggle,
  onOpen,
  onWorkflow,
  onStop,
  t,
}: {
  task: AgentTask
  subtasks: Map<string, AgentTask[]>
  collapsed: Set<string>
  toggle: (key: string) => void
  onOpen: (task: AgentTask) => void
  onWorkflow: (task: AgentTask) => void
  onStop: (taskId: string) => void
  t: T
}) {
  const children = subtasks.get(task.id) ?? []
  const open = children.length > 0 && !collapsed.has(task.id)
  const stop = !isFinished(task) ? () => onStop(task.id) : undefined
  if (task.type === 'local_workflow') {
    const phases = task.phases ?? []
    const agents = phases.flatMap(p => p.agents)
    return (
      <Node
        lead={<span className="glyph">◆</span>}
        name={taskName(task)}
        desc={task.description}
        badge={
          phases.length
            ? t('workflowPhase', {
                n: String(currentPhase(phases) + 1),
                total: String(phases.length),
                name: phases[currentPhase(phases)]!.label,
              })
            : statusText(task.status, t)
        }
        badgeClass={dotClass(task.status)}
        meta={t('phaseAgents', {
          done: String(agents.filter(a => a.status === 'completed').length),
          total: String(agents.length),
        })}
        onOpen={() => onWorkflow(task)}
        onStop={stop}
        stopLabel={t('stopTask', { name: taskName(task) })}
      />
    )
  }
  return (
    <>
      <Node
        lead={
          children.length ? (
            <button
              type="button"
              className="caret"
              aria-expanded={open}
              aria-label={taskName(task)}
              onClick={e => {
                e.stopPropagation()
                toggle(task.id)
              }}
            >
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span className={`dot ${dotClass(task.status)}`} />
          )
        }
        name={taskName(task)}
        desc={task.description}
        badge={statusText(task.status, t)}
        badgeClass={dotClass(task.status)}
        meta={taskMeta(task)}
        onOpen={() => onOpen(task)}
        onStop={stop}
        stopLabel={t('stopTask', { name: taskName(task) })}
      />
      {open && (
        <div className="branch">
          {children.map(child => (
            <TaskNode
              key={child.id}
              task={child}
              subtasks={subtasks}
              collapsed={collapsed}
              toggle={toggle}
              onOpen={onOpen}
              onWorkflow={onWorkflow}
              onStop={onStop}
              t={t}
            />
          ))}
        </div>
      )}
    </>
  )
}

const IDLE_FOLD = 3

function memberState(member: TeamMember, t: T): string {
  return member.state === 'working'
    ? t('memberWorking')
    : member.state === 'idle'
      ? t('teamIdle')
      : t('memberStopped')
}

/** The team group: members (idle ones folded past three, as in the TUI) and its messages. */
function TeamGroup({
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
    <Node
      key={member.task.id}
      className={`member-${member.state}`}
      lead={<TeamDot color={member.color} />}
      name={member.name}
      desc={member.task.description}
      badge={memberState(member, t)}
      badgeClass={member.state === 'working' ? 'running' : member.state === 'idle' ? 'idle' : 'killed'}
      meta={taskMeta(member.task)}
      onOpen={() => onOpenMember(member.task.id)}
    />
  )
  return (
    <div className="agent-section team-section">
      <Node
        lead={<span className="glyph">{open ? '▾' : '▸'}</span>}
        name={t('team')}
        badge={String(team.members.length)}
        meta={t('teamSummary', { working: String(working.length), idle: String(idle.length) })}
        onOpen={() => toggle('team')}
      />
      {open && (
        <div className="branch">
          {working.map(row)}
          {idleOpen ? (
            idle.map(row)
          ) : (
            <Node
              lead={<span className="glyph">▸</span>}
              name={t('idleAgents', { n: String(idle.length) })}
              onOpen={() => toggle('team:idle')}
            />
          )}
          {stopped.map(row)}
          <Node
            lead={<span className="glyph">≡</span>}
            name={t('teamMessages')}
            badge={String(team.events.length)}
            onOpen={onOpenMessages}
          />
        </div>
      )}
    </div>
  )
}

/** Lead and teammate messages in order, like a group chat. */
function TeamTimeline({ team, t }: { team: Team; t: T }) {
  const colors = new Map(team.members.map(m => [m.name, m.color]))
  if (!team.events.length) return <p className="note">{t('noTeamMessages')}</p>
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

function Group({
  id,
  title,
  count,
  collapsed,
  toggle,
  children,
}: {
  id: string
  title: string
  count: number
  collapsed: Set<string>
  toggle: (key: string) => void
  children: ReactNode
}) {
  if (!count) return null
  const open = !collapsed.has(id)
  return (
    <div className="agent-section">
      <div className="group-h">
        <button type="button" aria-expanded={open} onClick={() => toggle(id)}>
          {title} · {count}
        </button>
      </div>
      {open && (
        <div className="tree">
          <div className="branch">{children}</div>
        </div>
      )}
    </div>
  )
}

/** An agent's own conversation, with an input when it can be messaged. */
export function AgentView({
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
  const items = useMemo(() => (messages ?? []).reduce(reduce, initialState).items, [messages])
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
  const stoppedTeammate = task?.type === 'in_process_teammate' && isFinished(task)
  return (
    <div className="agent-pane">
      {task && (
        <div className="card">
          <span className="sub">
            {[task.subagentType ?? task.type, task.description, taskMeta(task)].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
      <div className="transcript agent-feed">
        {failed && !messages && <p className="note">{t('agentNoTranscript')}</p>}
        {!failed && !messages && <p className="note">{t('loading')}</p>}
        {joinTurns(items).map(({ item }) => (
          <Message key={item.id} item={item} t={t} streaming={false} />
        ))}
        {task?.outputFile && isFinished(task) && task.summary && <div className="card">{task.summary}</div>}
      </div>
      {note && (
        <div className="delivery" role="status">
          {note}
        </div>
      )}
      {onSend ? (
        <form
          className="agent-input"
          onSubmit={e => {
            e.preventDefault()
            void send()
          }}
        >
          <textarea
            rows={1}
            value={draft}
            disabled={stoppedTeammate}
            aria-label={t('message')}
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
          <button type="submit" className="btn primary" disabled={!draft.trim() || stoppedTeammate}>
            {t('send')}
          </button>
        </form>
      ) : (
        <p className="note">{t('agentReadonly')}</p>
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

/** The Agents tab: a tree rooted at the main session, and an agent's conversation. */
export function AgentsTab({
  sessionId,
  tasks: allTasks,
  items,
  busy,
  view,
  setView,
  onWorkflow,
  onStop,
  onSend,
  t,
}: {
  sessionId: string
  tasks: Tasks
  /** The lead's chat, for teammate names and team messages. */
  items: Item[]
  busy: boolean
  view: AgentsView
  setView: (view: AgentsView) => void
  onWorkflow: (taskId: string) => void
  onStop: (taskId: string) => void
  onSend: (taskId: string, text: string) => Promise<string>
  t: T
}) {
  const tasks = useMemo(() => agentTasks(allTasks), [allTasks])
  const [collapsed, toggle] = useCollapsed()
  const issuers = useIssuers(sessionId, tasks)
  const groups = groupTasks(tasks, issuers)
  const team = useMemo(() => buildTeam(tasks, items), [tasks, items])
  const selected = view.kind === 'task' ? tasks[view.id] : undefined
  const member = selected && team?.members.find(m => m.task.id === selected.id)
  const parent = selected && parentId(selected, tasks, issuers)
  const inWorkflow = parent !== undefined && tasks[parent]?.type === 'local_workflow'

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
    <TaskNode
      key={task.id}
      task={task}
      subtasks={groups.children}
      collapsed={collapsed}
      toggle={toggle}
      onOpen={task => setView({ kind: 'task', id: task.id })}
      onWorkflow={task => onWorkflow(task.id)}
      onStop={onStop}
      t={t}
    />
  )

  if (view.kind !== 'tree') {
    const title =
      view.kind === 'team'
        ? t('team')
        : member
          ? member.name
          : selected
            ? taskName(selected)
            : view.kind === 'agent'
              ? view.name
              : ''
    return (
      <>
        <div className="crumb">
          <button type="button" aria-label={t('back')} onClick={() => setView({ kind: 'tree' })}>
            Agents
          </button>
          / {title}
          {selected && (
            <>
              <span className={`dot ${dotClass(selected.status)}`} /> {statusText(selected.status, t)}
            </>
          )}
        </div>
        {selected && (
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
        {view.kind === 'task' && !selected && <p className="note">{t('noAgents')}</p>}
        {view.kind === 'agent' && <AgentView sessionId={sessionId} agentId={view.id} t={t} />}
      </>
    )
  }
  return (
    <>
      <div className="group-h">{t('runningGroup')}</div>
      <div className="tree">
        <Node
          lead={<span className={`dot ${busy ? 'running' : 'idle'}`} />}
          name={t('mainSession')}
          badge={busy ? 'running' : 'idle'}
          badgeClass={busy ? 'running' : 'idle'}
        />
        {(groups.running.length > 0 || team) && (
          <div className="branch">
            {groups.running.map(row)}
            {team && (
              <TeamGroup
                team={team}
                collapsed={collapsed}
                toggle={toggle}
                onOpenMember={id => setView({ kind: 'task', id })}
                onOpenMessages={() => setView({ kind: 'team' })}
                t={t}
              />
            )}
          </div>
        )}
      </div>
      {!groups.running.length && !groups.finished.length && !team && (
        <p className="note">{t('noAgents')}</p>
      )}
      <Group
        id="finished"
        title={t('endedGroup')}
        count={groups.finished.length}
        collapsed={collapsed}
        toggle={toggle}
      >
        {groups.finished.map(row)}
      </Group>
    </>
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
    <div className="lanes wfd-lanes">
      {phases.map((phase, i) => (
        <div key={phase.index} className={`lane${i === current ? ' cur' : ''}`}>
          <h3>
            <span className={`dot ${dotClass(phase.status)}`} />
            {i + 1}. {phase.label} · {phase.agents.filter(a => a.status === 'completed').length}/
            {phase.agents.length}
          </h3>
          {phase.message && <p>{phase.message}</p>}
          {phase.agents.map(agent => (
            <button type="button" key={agent.label} className="wcard" onClick={() => onOpenAgent(agent.label)}>
              <b>{agent.label}</b>
              <span>
                <span className={`dot ${dotClass(agent.status)}`} /> {agent.status}
              </span>
            </button>
          ))}
          {i < phases.length - 1 && (
            <span className="arrow" aria-hidden="true">
              →
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function PhaseLine({ phases, task, t, onExpand }: { phases: WorkflowPhase[]; task: AgentTask; t: T; onExpand?: () => void }) {
  const i = currentPhase(phases)
  const phase = phases[i]
  if (!phase) {
    return (
      <div className="wfcur">
        <span className={`dot ${dotClass(task.status)}`} />
        <b>{taskName(task)}</b>
        <span className="note">{statusText(task.status, t)}</span>
      </div>
    )
  }
  const running = phase.agents.filter(a => a.status === 'running').map(a => a.label)
  return (
    <div className="wfcur">
      <span className={`dot ${dotClass(phase.status)}`} />
      <b>{t('workflowPhase', { n: String(i + 1), total: String(phases.length), name: phase.label })}</b>
      <span className="note">
        {t('phaseDone', {
          done: String(phase.agents.filter(a => a.status === 'completed').length),
          total: String(phase.agents.length),
        })}
        {running.length > 0 && t('runningNow', { names: running.join('、') })}
      </span>
      {onExpand && (
        <button className="btn" type="button" onClick={onExpand}>
          {t('expand')}
        </button>
      )}
    </div>
  )
}

/** The Workflow tab: the current phase of a workflow, its agent cards and the full lanes on demand. */
export function WorkflowTab({
  sessionId,
  tasks,
  selectedId,
  setSelectedId,
  onStop,
  t,
}: {
  sessionId: string
  tasks: Tasks
  selectedId?: string
  setSelectedId: (id: string | undefined) => void
  onStop: (taskId: string) => void
  t: T
}) {
  const workflows = Object.values(tasks)
    .filter(task => task.type === 'local_workflow')
    .sort((a, b) => b.seq - a.seq)
  const [expanded, setExpanded] = useState(false)
  const [agentLabel, setAgentLabel] = useState<string>()
  const task = (selectedId && tasks[selectedId]) || workflows[0]
  useEffect(() => setAgentLabel(undefined), [task?.id])
  if (!task) return <p className="note">{t('noWorkflow')}</p>
  const phases = task.phases ?? []
  const allAgents = phases.flatMap(p => p.agents)
  const done = allAgents.filter(a => a.status === 'completed').length
  const current = phases[currentPhase(phases)]
  const agentTask = agentLabel ? workflowAgent(tasks, task, agentLabel) : undefined
  return (
    <>
      <div className="crumb">
        {workflows.length > 1 ? (
          workflows.map(w => (
            <button type="button" key={w.id} onClick={() => setSelectedId(w.id)} aria-pressed={w.id === task.id}>
              {taskName(w)}
            </button>
          ))
        ) : (
          <span>workflow {taskName(task)}</span>
        )}
        {!isFinished(task) && (
          <button type="button" onClick={() => onStop(task.id)}>
            {t('stopWorkflow')}
          </button>
        )}
      </div>
      <PhaseLine phases={phases} task={task} t={t} onExpand={phases.length ? () => setExpanded(true) : undefined} />
      {allAgents.length > 0 && (
        <div className="bar">
          <i style={{ width: `${Math.round((done / allAgents.length) * 100)}%` }} />
        </div>
      )}
      {current && (
        <div className="wfnow">
          {current.agents.map(agent => (
            <button
              type="button"
              key={agent.label}
              className="wcard"
              aria-pressed={agentLabel === agent.label}
              onClick={() => setAgentLabel(agent.label)}
            >
              <b>{agent.label}</b>
              <span>
                <span className={`dot ${dotClass(agent.status)}`} /> {agent.status}
              </span>
            </button>
          ))}
        </div>
      )}
      {task.summary && <div className="card">{task.summary}</div>}
      {agentLabel && (
        <div className="wfout">
          <div className="fhead">
            <b className="mono">{agentLabel}</b>
            {agentTask && <span className="note">{taskMeta(agentTask)}</span>}
          </div>
          <AgentView sessionId={sessionId} agentId={agentTask?.id ?? agentLabel} task={agentTask} t={t} />
        </div>
      )}
      {expanded && (
        <Dialog t={t} xl title="Workflow" onClose={() => setExpanded(false)}>
          <div className="wfdlg">
            <div className="wfd-head">
              <b>{taskName(task)}</b>
              {task.description && <span>{task.description}</span>}
              <span>
                {[taskMeta(task), t('phaseAgents', { done: String(done), total: String(allAgents.length) })]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {!isFinished(task) && (
                <button className="btn" type="button" onClick={() => onStop(task.id)}>
                  {t('stopWorkflow')}
                </button>
              )}
            </div>
            <div className="bar">
              <i style={{ width: `${allAgents.length ? Math.round((done / allAgents.length) * 100) : 0}%` }} />
            </div>
            <PhaseLine phases={phases} task={task} t={t} />
            <WorkflowLanes
              phases={phases}
              onOpenAgent={label => {
                setExpanded(false)
                setAgentLabel(label)
              }}
            />
          </div>
        </Dialog>
      )}
    </>
  )
}
