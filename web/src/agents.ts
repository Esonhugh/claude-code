// Background work of a session (subagents, workflows, teammates, shells),
// folded from the `system/task_*` stream-json events.

import type { Item } from './protocol'

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined
const num = (v: unknown): number | undefined =>
  typeof v === 'number' ? v : undefined

export type WorkflowPhase = {
  index: number
  label: string
  status: string
  message?: string
  agents: { label: string; status: string }[]
}

export type AgentTask = {
  id: string
  type: string
  description: string
  /** The description it started with; a running agent's progress replaces `description` with its activity. */
  title?: string
  status: string
  subagentType?: string
  workflowName?: string
  toolUseId?: string
  depth: number
  background?: boolean
  tokens?: number
  toolUses?: number
  durationMs?: number
  lastTool?: string
  summary?: string
  outputFile?: string
  error?: string
  phases?: WorkflowPhase[]
  /** Order of first sighting, for stable sorting. */
  seq: number
}

export type Tasks = Record<string, AgentTask>

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'killed'])

export function isFinished(task: AgentTask): boolean {
  return TERMINAL.has(task.status)
}

function phasesFrom(entries: unknown[]): WorkflowPhase[] {
  const phases = new Map<number, WorkflowPhase>()
  for (const e of entries.filter(isObj)) {
    if (e.type === 'phase') {
      const index = num(e.index) ?? phases.size
      phases.set(index, {
        index,
        label: str(e.label) ?? `#${index + 1}`,
        status: str(e.status) ?? 'pending',
        message: str(e.message),
        agents: phases.get(index)?.agents ?? [],
      })
    }
  }
  for (const e of entries.filter(isObj)) {
    if (e.type !== 'agent') continue
    const phase = phases.get(num(e.phaseIndex) ?? -1)
    if (phase) {
      phase.agents.push({ label: str(e.label) ?? '', status: str(e.status) ?? 'pending' })
    }
  }
  return [...phases.values()].sort((a, b) => a.index - b.index)
}

function usage(raw: Json): Partial<AgentTask> {
  const u = isObj(raw.usage) ? raw.usage : undefined
  return u
    ? {
        tokens: num(u.total_tokens),
        toolUses: num(u.tool_uses),
        durationMs: num(u.duration_ms),
      }
    : {}
}

function withoutUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Folds one stream-json message into the task map; other messages pass through. */
export function reduceTasks(tasks: Tasks, raw: unknown): Tasks {
  if (!isObj(raw) || raw.type !== 'system') return tasks
  const id = str(raw.task_id)
  const existing = id ? tasks[id] : undefined
  const put = (patch: Partial<AgentTask>): Tasks => {
    if (!id) return tasks
    const base: AgentTask = existing ?? {
      id,
      type: 'local_agent',
      description: '',
      status: 'running',
      depth: 0,
      seq: Object.keys(tasks).length,
    }
    return { ...tasks, [id]: { ...base, ...withoutUndefined(patch) } }
  }
  switch (raw.subtype) {
    case 'task_started':
      return put({
        type: str(raw.task_type) ?? existing?.type ?? 'local_agent',
        description: str(raw.description) ?? '',
        title: str(raw.description),
        // A resumed task starts a new run.
        status: 'running',
        subagentType: str(raw.subagent_type),
        workflowName: str(raw.workflow_name),
        toolUseId: str(raw.tool_use_id),
        depth: num(raw.spawn_depth) ?? 0,
        background: raw.is_backgrounded === true ? true : undefined,
        error: undefined,
      })
    case 'task_progress': {
      const progress = Array.isArray(raw.workflow_progress)
        ? phasesFrom(raw.workflow_progress)
        : undefined
      return put({
        description: str(raw.description),
        subagentType: str(raw.subagent_type),
        toolUseId: str(raw.tool_use_id),
        lastTool: str(raw.last_tool_name),
        summary: str(raw.summary),
        phases: progress,
        ...usage(raw),
      })
    }
    case 'task_updated': {
      const patch = isObj(raw.patch) ? raw.patch : {}
      return put({
        status: str(patch.status),
        description: str(patch.description),
        error: str(patch.error),
        background: typeof patch.is_backgrounded === 'boolean' ? patch.is_backgrounded : undefined,
      })
    }
    case 'task_notification':
      return put({
        status: str(raw.status),
        summary: str(raw.summary),
        outputFile: str(raw.output_file) || undefined,
        toolUseId: str(raw.tool_use_id),
        ...usage(raw),
      })
    case 'background_tasks_changed': {
      // A snapshot of what is still running: anything missing has ended.
      const live = new Map(
        (Array.isArray(raw.tasks) ? raw.tasks : [])
          .filter(isObj)
          .map(t => [str(t.task_id) ?? '', t] as const),
      )
      let next = tasks
      for (const task of Object.values(tasks)) {
        if (!isFinished(task) && !live.has(task.id)) {
          next = { ...next, [task.id]: { ...task, status: 'completed' } }
        }
      }
      for (const [taskId, t] of live) {
        if (!taskId || next[taskId]) continue
        next = {
          ...next,
          [taskId]: {
            id: taskId,
            type: str(t.task_type) ?? 'local_agent',
            description: str(t.description) ?? '',
            subagentType: str(t.subagent_type),
            status: 'running',
            depth: 0,
            seq: Object.keys(next).length,
          },
        }
      }
      return next
    }
    default:
      return tasks
  }
}

/** The name a row leads with. */
export function taskName(task: AgentTask): string {
  if (task.type === 'local_workflow') return task.workflowName ?? 'workflow'
  if (task.type === 'local_bash') return 'bash'
  return task.subagentType ?? task.type
}

/** Agents that hold a conversation the panel can open and message. */
export function canChat(task: AgentTask): boolean {
  return task.type === 'local_agent' || task.type === 'in_process_teammate'
}

/**
 * The task a task runs under: the workflow that started it, or the agent
 * whose transcript issued its Agent call (`issuers`, looked up by the server).
 */
export function parentId(
  task: AgentTask,
  tasks: Tasks,
  issuers: Record<string, string>,
): string | undefined {
  if (!task.toolUseId || task.type === 'local_workflow') return undefined
  const workflow = Object.values(tasks).find(
    t => t.type === 'local_workflow' && t.toolUseId === task.toolUseId,
  )
  if (workflow) return workflow.id
  const issuer = issuers[task.toolUseId]
  return issuer && issuer !== task.id && tasks[issuer] ? issuer : undefined
}

/** Agent calls made inside a subagent, whose issuer the server has to find. */
export function unresolvedIssuers(tasks: Tasks, issuers: Record<string, string>): string[] {
  return Object.values(tasks)
    .filter(
      t =>
        t.type === 'local_agent' &&
        t.depth > 0 &&
        t.toolUseId &&
        !issuers[t.toolUseId] &&
        parentId(t, tasks, issuers) === undefined,
    )
    .map(t => t.toolUseId!)
}

export type TaskGroups = {
  /** Top-level tasks; teammates are grouped by `buildTeam` instead. */
  running: AgentTask[]
  finished: AgentTask[]
  /** Subagents under the agent that started them (workflow agents excluded). */
  children: Map<string, AgentTask[]>
}

export function groupTasks(tasks: Tasks, issuers: Record<string, string> = {}): TaskGroups {
  const all = Object.values(tasks)
    .filter(t => t.type !== 'in_process_teammate')
    .sort((a, b) => a.seq - b.seq)
  const roots: AgentTask[] = []
  const children = new Map<string, AgentTask[]>()
  for (const task of all) {
    const parent = parentId(task, tasks, issuers)
    if (!parent) roots.push(task)
    else if (tasks[parent]!.type !== 'local_workflow') {
      children.set(parent, [...(children.get(parent) ?? []), task])
    }
  }
  return {
    running: roots.filter(t => !isFinished(t)),
    finished: roots.filter(isFinished),
    children,
  }
}

/** The agent a workflow phase card stands for (its description is `<workflow>: <label>`). */
export function workflowAgent(tasks: Tasks, workflow: AgentTask, label: string): AgentTask | undefined {
  return Object.values(tasks).find(
    t =>
      t.id !== workflow.id &&
      t.toolUseId === workflow.toolUseId &&
      (t.title ?? t.description).endsWith(`: ${label}`),
  )
}

/** A teammate color name, or nothing when it is not a plain CSS color word. */
export function teamColor(color: string | undefined): string | undefined {
  return color && /^[a-z]{1,20}$/i.test(color) ? color : undefined
}

/** A teammate message body: plain text, or a protocol message such as an idle notification. */
export function teammateEvent(text: string): { type?: string; detail: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (isObj(parsed) && typeof parsed.type === 'string') {
      return {
        type: parsed.type,
        detail:
          str(parsed.result) ?? str(parsed.reason) ?? str(parsed.content) ?? str(parsed.message) ?? '',
      }
    }
  } catch {
    // Plain text.
  }
  return { detail: text }
}

export type TeamMember = {
  task: AgentTask
  name: string
  color?: string
  /** Transcript id of the teammate (`agent-<id>.jsonl`). */
  agentId?: string
  state: 'working' | 'idle' | 'stopped'
}

export type TeamEvent = {
  id: string
  from: string
  to: string
  color?: string
  /** Protocol message type, e.g. `idle_notification` or `shutdown_request`. */
  type?: string
  text: string
}

export type Team = { members: TeamMember[]; events: TeamEvent[] }

export const TEAM_LEAD = 'team-lead'

function parseInput(input: string | undefined): Json {
  try {
    const value: unknown = JSON.parse(input ?? '')
    return isObj(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * The session's agent team: its teammate tasks, named by the Agent calls that
 * spawned them, and the messages between the lead and its teammates as the
 * lead's chat shows them (teammate prompts and SendMessage calls).
 */
export function buildTeam(tasks: Tasks, items: Item[]): Team | undefined {
  const teammates = Object.values(tasks)
    .filter(t => t.type === 'in_process_teammate')
    .sort((a, b) => a.seq - b.seq)
  if (!teammates.length) return undefined
  const tools = new Map<string, { input: string; result?: string }>()
  const events: TeamEvent[] = []
  for (const item of items) {
    if (item.kind === 'teammate') {
      const event = teammateEvent(item.text)
      events.push({
        id: item.id,
        from: item.from,
        to: TEAM_LEAD,
        color: teamColor(item.color),
        type: event.type,
        text: event.detail || (item.summary ?? ''),
      })
      continue
    }
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block?.kind !== 'tool') continue
      tools.set(block.id, block)
      const input = block.name === 'SendMessage' ? parseInput(block.input) : {}
      const to = str(input.to)
      if (!to) continue
      const message = input.message
      events.push({
        id: block.id,
        from: TEAM_LEAD,
        to,
        type: isObj(message) ? str(message.type) : undefined,
        text: typeof message === 'string' && message ? message : (str(input.summary) ?? ''),
      })
    }
  }
  const members: TeamMember[] = teammates.map(task => {
    const tool = task.toolUseId ? tools.get(task.toolUseId) : undefined
    const name = str(parseInput(tool?.input).name) ?? task.description
    const last = events.findLast(e => e.from === name || e.to === name || e.to === '*')
    return {
      task,
      name,
      color: events.findLast(e => e.from === name && e.color)?.color,
      agentId: /^agent_id: (\S+)$/m.exec(tool?.result ?? '')?.[1],
      state: isFinished(task)
        ? 'stopped'
        : last?.from === name && last.type === 'idle_notification'
          ? 'idle'
          : 'working',
    }
  })
  const names = new Set(members.map(m => m.name))
  return {
    members,
    events: events.filter(e => names.has(e.from) || names.has(e.to) || e.to === '*'),
  }
}

export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export function formatTokens(n: number | undefined): string | undefined {
  if (n === undefined) return undefined
  return n < 1000 ? `${n} tok` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tok`
}

/** Indexes of the phases running now (pipelined phases overlap), or just the current one. */
export function runningPhases(phases: WorkflowPhase[]): number[] {
  const running = phases.flatMap((p, i) => (p.status === 'running' ? [i] : []))
  return running.length || !phases.length ? running : [currentPhase(phases)]
}

/** Index of the phase a workflow is in: the latest running (pipelined phases overlap), else the first pending, else the last. */
export function currentPhase(phases: WorkflowPhase[]): number {
  const running = phases.findLastIndex(p => p.status === 'running')
  if (running !== -1) return running
  const i = phases.findIndex(p => p.status === 'pending')
  return i === -1 ? phases.length - 1 : i
}
