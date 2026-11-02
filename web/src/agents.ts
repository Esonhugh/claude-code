// Background work of a session (subagents, workflows, teammates, shells),
// folded from the `system/task_*` stream-json events.

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

export type TaskGroups = { running: AgentTask[]; finished: AgentTask[] }

export function groupTasks(tasks: Tasks): TaskGroups {
  const all = Object.values(tasks).sort((a, b) => a.seq - b.seq)
  return {
    running: all.filter(t => !isFinished(t)),
    finished: all.filter(isFinished),
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

/** Index of the phase a workflow is in: the first not yet done, else the last. */
export function currentPhase(phases: WorkflowPhase[]): number {
  const i = phases.findIndex(p => p.status === 'running' || p.status === 'pending')
  return i === -1 ? phases.length - 1 : i
}
