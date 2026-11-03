import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import {
  agentOutput,
  type AgentTask,
  buildTeam,
  canChat,
  currentPhase,
  formatDuration,
  formatTokens,
  groupTasks,
  isFinished,
  parentId,
  phaseActive,
  runningPhases,
  type Tasks,
  taskName,
  type Team,
  TEAM_LEAD,
  type TeamMember,
  unresolvedIssuers,
  type WorkflowPhase,
  workflowAgent,
  workflowPhases,
} from '../agents'
import { loadAgentIssuers, loadAgentTranscript } from '../api'
import { mentionPath, uploadFile } from '../files'
import { initialState, type Item, reduce } from '../protocol'
import { ChatComposer, type ComposerTools } from './Composer'
import { Dialog } from './Dialog'
import { AgentConversation, joinTurns, Message, type SentMessage, TeamDot, teamEventLabel, useUnread } from './Message'
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
  return status === 'stopped' ? 'killed' : status === 'queued' ? 'pending' : status
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
  input,
  embedded,
  t,
}: {
  sessionId: string
  agentId: string
  task?: AgentTask
  /** Shown in the input's placeholder; defaults to the task's name. */
  name?: string
  onSend?: (text: string, pick: AgentPick) => Promise<void>
  input?: AgentInput
  /** Inside a Workflow pane whose header already names the agent: no task card, no read-only note. */
  embedded?: boolean
  t: T
}) {
  const [messages, setMessages] = useState<unknown[]>()
  const [failed, setFailed] = useState(false)
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [pick, setPick] = useState<AgentPick>({})
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
  const prompts = useMemo(() => items.flatMap(i => (i.kind === 'user' && i.text ? [i.text] : [])), [items])
  // What the user sent shows at once, until the agent's conversation has it.
  const [sent, setSent] = useState<SentMessage[]>([])
  const dropSent = useCallback((ids: string[]) => setSent(s => s.filter(m => !ids.includes(m.id))), [])
  const unread = useUnread(items, sent, dropSent)
  const send = async () => {
    const text = draft.trim()
    if ((!text && !files.length) || !onSend) return
    const id = `sent-${Date.now()}-${Math.random()}`
    try {
      const mentions = await Promise.all(files.map(async f => mentionPath((await uploadFile(sessionId, f)).path)))
      const message = [text, mentions.join(' ')].filter(Boolean).join('\n\n')
      setDraft('')
      setFiles([])
      setNote(undefined)
      setSent(s => [...s, { id, text: message }])
      await onSend(message, running ? {} : pick)
      setPoll(n => n + 1)
      setFollowUntil(Date.now() + 30_000)
    } catch (err) {
      setSent(s => s.filter(m => m.id !== id))
      setNote(err instanceof Error ? err.message : String(err))
    }
  }
  const teammate = task?.type === 'in_process_teammate'
  const stoppedTeammate = teammate && isFinished(task)
  return (
    <div className="agent-pane">
      {task && !embedded && (
        <div className="card">
          <span className="sub">
            {[task.subagentType ?? task.type, task.description, taskMeta(task)].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
      <AgentConversation>
      <div className="transcript agent-feed">
        {failed && !messages && <p className="note">{t('agentNoTranscript')}</p>}
        {!failed && !messages && <p className="note">{t('loading')}</p>}
        {joinTurns(items).map(({ item }) => (
          <Message key={item.id} item={item} t={t} streaming={false} />
        ))}
        {unread.map(m => (
          <Message key={m.id} item={{ kind: 'user', id: m.id, text: m.text }} t={t} streaming={false} />
        ))}
        {task?.outputFile && isFinished(task) && task.summary && <div className="card">{task.summary}</div>}
      </div>
      </AgentConversation>
      {note && (
        <div className="delivery no" role="status">
          {note}
        </div>
      )}
      {onSend && input ? (
        <div className="composer agent-input">
          <ChatComposer
            t={t}
            agent
            busy={false}
            disabled={stoppedTeammate}
            signedOut={input.signedOut}
            draft={draft}
            setDraft={setDraft}
            onSend={() => void send()}
            onStop={() => {}}
            files={files}
            setFiles={setFiles}
            placeholder={stoppedTeammate ? t('teammateStopped') : t('sendTo', { name: name ?? (task ? taskName(task) : agentId) })}
            tools={{
              ...input.tools,
              prompts,
              model: {
                model: pick.model ?? input.model,
                effort: pick.effort ?? input.effort,
                models: input.models,
                // A running agent keeps its model for this run (the pick applies when it resumes); a teammate never resumes.
                heading: teammate ? t('taskModelLocked') : running ? t('taskModelAfterRun') : t('taskModelNext'),
                locked: teammate,
                onModel: model => setPick(p => ({ ...p, model })),
                onEffort: effort => setPick(p => ({ ...p, effort })),
              },
            }}
          />
        </div>
      ) : (
        !embedded && <p className="note">{t('agentReadonly')}</p>
      )}
    </div>
  )
}

/** The model and effort a finished agent resumes on. */
export type AgentPick = { model?: string; effort?: string }

/** What an agent's input box shares with the session's own. */
export type AgentInput = {
  tools: Omit<ComposerTools, 'prompts' | 'model'>
  model: string | undefined
  effort: string | undefined
  models: ComposerTools['model']['models']
  /** Signed out: the box is disabled and says why, like the session's own. */
  signedOut?: boolean
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
  input,
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
  onSend: (taskId: string, text: string, pick: AgentPick) => Promise<void>
  input: AgentInput
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
            key={selected.id}
            sessionId={sessionId}
            agentId={member?.agentId ?? selected.id}
            task={selected}
            name={member?.name}
            onSend={canChat(selected) && !inWorkflow ? (text, pick) => onSend(selected.id, text, pick) : undefined}
            input={input}
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
  picked,
  onOpenAgent,
  t,
}: {
  phases: WorkflowPhase[]
  picked?: string
  onOpenAgent: (label: string) => void
  t: T
}) {
  const current = currentPhase(phases)
  return (
    <div className="kanban">
      {phases.map((phase, i) => {
        const running = phase.agents.filter(a => a.status === 'running').length
        return (
          <section key={phase.index} className={`kcol${i === current || phaseActive(phase) ? ' cur' : ''}`}>
            <header>
              <span className={`dot ${dotClass(phase.status)}`} />
              <b>
                {i + 1}. {phase.label}
              </b>
              {running > 0 && <span className="note">{t('nRunning', { n: String(running) })}</span>}
              <span className="count">
                {phase.agents.filter(a => a.status === 'completed').length}/{phase.agents.length}
              </span>
            </header>
            {phase.message && <p>{phase.message}</p>}
            <div className="kcards">
              {phase.agents.map(agent => (
                <button
                  type="button"
                  key={agent.label}
                  className="wcard"
                  aria-pressed={picked === agent.label}
                  onClick={() => onOpenAgent(agent.label)}
                >
                  <b>{agent.label}</b>
                  <span>
                    <span className={`dot ${dotClass(agent.status)}`} /> {agent.status}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function PhaseLine({
  phases,
  index,
  task,
  t,
  open,
  onToggle,
}: {
  phases: WorkflowPhase[]
  index: number
  task: AgentTask
  t: T
  /** Given, the line is a drawer header that opens and closes the phase's cards. */
  open?: boolean
  onToggle?: () => void
}) {
  const phase = phases[index]
  if (!phase) {
    return (
      <div className="wfcur">
        <span className={`dot ${dotClass(task.status)}`} />
        <b>{taskName(task)}</b>
        <span className="note">{statusText(task.status, t)}</span>
      </div>
    )
  }
  // The cards show which agents run; the heading only counts them.
  const running = phase.agents.filter(a => a.status === 'running').length
  const body = (
    <>
      <span className={`dot ${dotClass(phase.status)}`} />
      <b>{t('workflowPhase', { n: String(index + 1), total: String(phases.length), name: phase.label })}</b>
      <span className="note">
        {t('phaseDone', {
          done: String(phase.agents.filter(a => a.status === 'completed').length),
          total: String(phase.agents.length),
        })}
        {running > 0 && ` · ${t('nRunning', { n: String(running) })}`}
      </span>
    </>
  )
  return onToggle ? (
    <button type="button" className="wfcur wfdrawer" aria-expanded={open} onClick={onToggle}>
      {body}
    </button>
  ) : (
    <div className="wfcur">{body}</div>
  )
}

/** An agent's full output (structured output, else its last reply) in a dialog, with Copy. */
function AgentOutputDialog({ sessionId, agentId, label, t, onClose }: { sessionId: string; agentId: string; label: string; t: T; onClose: () => void }) {
  const [output, setOutput] = useState<ReturnType<typeof agentOutput> | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let live = true
    loadAgentTranscript(sessionId, agentId).then(
      page => live && setOutput(agentOutput(page.messages)),
      () => live && setOutput(undefined),
    )
    return () => {
      live = false
    }
  }, [sessionId, agentId])
  const copy = () => {
    if (!output) return
    void navigator.clipboard?.writeText(output.text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <Dialog t={t} xl title={<span className="mono">{label}</span>} onClose={onClose}>
      <div className="wfresult">
        <div className="fhead">
          <span className="note">{output?.structured ? 'Structured output' : t('agentOutput')}</span>
          <button className="btn" type="button" disabled={!output} onClick={copy}>
            {t(copied ? 'copied' : 'copy')}
          </button>
        </div>
        {output === null ? (
          <p className="note">{t('loading')}</p>
        ) : output ? (
          <pre className="mono">{output.text}</pre>
        ) : (
          <p className="note">{t('agentNoTranscript')}</p>
        )}
      </div>
    </Dialog>
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
  // Drawers the user opened or closed; the rest follow the phase (running ones open).
  const [toggled, setToggled] = useState<Map<number, boolean>>(() => new Map())
  const [showOutput, setShowOutput] = useState(false)
  const task = (selectedId && tasks[selectedId]) || workflows[0]
  useEffect(() => {
    setAgentLabel(undefined)
    setToggled(new Map())
  }, [task?.id])
  if (!task) return <p className="note">{t('noWorkflow')}</p>
  const phases = workflowPhases(tasks, task)
  const allAgents = phases.flatMap(p => p.agents)
  const done = allAgents.filter(a => a.status === 'completed').length
  const currentIndex = currentPhase(phases)
  // Every phase is a drawer; running ones (pipelined phases overlap) start open, else the current one.
  const lines = runningPhases(phases)
  const isOpen = (i: number) => toggled.get(i) ?? lines.includes(i)
  const agentTask = agentLabel ? workflowAgent(tasks, task, agentLabel) : undefined
  const toggle = (i: number) => setToggled(prev => new Map(prev).set(i, !isOpen(i)))
  return (
    <div className={`wftab${agentLabel ? ' split' : ''}`}>
      <div className="crumb">
        {workflows.length > 1 ? (
          workflows.map(w => {
            // Runs of the same workflow are told apart by their order, oldest first.
            const same = workflows.filter(x => taskName(x) === taskName(w))
            return (
              <button type="button" key={w.id} onClick={() => setSelectedId(w.id)} aria-pressed={w.id === task.id}>
                <span className={`dot ${dotClass(w.status)}`} /> {taskName(w)}
                {same.length > 1 && ` #${same.length - same.indexOf(w)}`}
              </button>
            )
          })
        ) : (
          <span>workflow {taskName(task)}</span>
        )}
        <span className="wfacts">
          {phases.length > 0 && (
            <button className="btn" type="button" onClick={() => setExpanded(true)}>
              {t('expand')}
            </button>
          )}
          {!isFinished(task) && (
            <button className="btn danger" type="button" onClick={() => onStop(task.id)}>
              {t('stopWorkflow')}
            </button>
          )}
        </span>
      </div>
      {allAgents.length > 0 && (
        <div className="bar">
          <i style={{ width: `${Math.round((done / allAgents.length) * 100)}%` }} />
        </div>
      )}
      {agentLabel && (
        <div className="wfout">
          <div className="fhead">
            <b className="mono">{agentLabel}</b>
            {agentTask && <span className="note">{taskMeta(agentTask)}</span>}
            {agentTask && (
              <button className="btn" type="button" onClick={() => setShowOutput(true)}>
                {t('expand')}
              </button>
            )}
          </div>
          <AgentView
            key={agentTask?.id ?? agentLabel}
            sessionId={sessionId}
            agentId={agentTask?.id ?? agentLabel}
            task={agentTask}
            embedded
            t={t}
          />
        </div>
      )}
      <div className="wflist">
        {phases.length === 0 && <PhaseLine phases={phases} index={currentIndex} task={task} t={t} />}
        {phases.map((phase, i) => (
          <Fragment key={phase.index}>
            <PhaseLine phases={phases} index={i} task={task} t={t} open={isOpen(i)} onToggle={() => toggle(i)} />
            {isOpen(i) && phase.agents.length > 0 && (
              <div className="wfnow">
                {phase.agents.map(agent => (
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
          </Fragment>
        ))}
        {task.summary && <div className="card">{task.summary}</div>}
      </div>
      {showOutput && agentLabel && agentTask && (
        <AgentOutputDialog
          sessionId={sessionId}
          agentId={agentTask.id}
          label={agentLabel}
          t={t}
          onClose={() => setShowOutput(false)}
        />
      )}
      {expanded && (
        <Dialog t={t} xl title="Workflow" onClose={() => setExpanded(false)}>
          <div className={`wfdlg${agentLabel ? ' split' : ''}`}>
            <div className="wfd-head">
              <b>{taskName(task)}</b>
              {task.description && <span>{task.description}</span>}
              <span>
                {[taskMeta(task), t('phaseAgents', { done: String(done), total: String(allAgents.length) })]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {!isFinished(task) && (
                <button className="btn danger" type="button" onClick={() => onStop(task.id)}>
                  {t('stopWorkflow')}
                </button>
              )}
            </div>
            <div className="bar">
              <i style={{ width: `${allAgents.length ? Math.round((done / allAgents.length) * 100) : 0}%` }} />
            </div>
            <WorkflowLanes phases={phases} picked={agentLabel} onOpenAgent={setAgentLabel} t={t} />
            {agentLabel && (
              <div className="wfout wfd-out">
                <div className="fhead">
                  <b className="mono">{agentLabel}</b>
                  {agentTask && <span className="note">{taskMeta(agentTask)}</span>}
                </div>
                <AgentView
                  key={agentTask?.id ?? agentLabel}
                  sessionId={sessionId}
                  agentId={agentTask?.id ?? agentLabel}
                  task={agentTask}
                  embedded
                  t={t}
                />
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  )
}
