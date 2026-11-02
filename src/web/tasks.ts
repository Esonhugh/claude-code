import type { Database } from 'bun:sqlite'

/**
 * A project's tasks in `projects.sqlite`, folded from its coordinator's
 * stream-json as the server relays it (docs/design/claude-web-project.md 4.2
 * and 5). A task is one worker the coordinator started with the Agent tool.
 */

/** running · blocked (an unanswered approval) · review (finished, not looked at) · done · stopped. */
export type TaskState = 'running' | 'blocked' | 'review' | 'done' | 'stopped'

/** Why a task stopped: the user (or the coordinator) stopped it, it failed, or its process went away (or was restarting). */
export type StopReason = 'user' | 'failed' | 'exited' | 'restart'

export type Task = {
  id: string
  project_id: string
  /** The coordinator session whose transcript folder holds the worker's. */
  session_id: string
  agent_id: string
  tool_use_id: string | null
  title: string
  brief: string
  subagent_type: string | null
  /** The model the user picked for the task's next run (`send_task_message`). */
  model: string | null
  effort: string | null
  worktree: string | null
  state: TaskState
  stop_reason: StopReason | null
  error: string | null
  summary: string | null
  tokens: number
  tool_uses: number
  duration_ms: number
  last_tool: string | null
  /** The pending `can_use_tool` request while blocked. */
  approval_id: string | null
  created_at: number
  updated_at: number
  /** When the current run started; a resumed task starts a new run. */
  started_at: number
  finished_at: number | null
  reviewed_at: number | null
}

export type TaskEvent = {
  id: number
  task_id: string
  ts: number
  kind: 'started' | 'finished' | 'stopped' | 'approval' | 'message' | 'reviewed'
  payload: string | null
}

export const TASK_MIGRATION = [
  'ALTER TABLE projects ADD COLUMN coordinator_model TEXT',
  'ALTER TABLE projects ADD COLUMN coordinator_effort TEXT',
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    tool_use_id TEXT,
    title TEXT NOT NULL,
    brief TEXT NOT NULL DEFAULT '',
    subagent_type TEXT,
    model TEXT,
    effort TEXT,
    worktree TEXT,
    state TEXT NOT NULL,
    stop_reason TEXT,
    error TEXT,
    summary TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    tool_uses INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    last_tool TEXT,
    approval_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    reviewed_at INTEGER
  )`,
  'CREATE INDEX tasks_project ON tasks(project_id, updated_at DESC)',
  `CREATE TABLE task_events (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT
  )`,
  'CREATE INDEX task_events_task ON task_events(task_id, id)',
]

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A stream-json line as an object, or undefined. */
export function parseLine(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isObj(value) ? value : undefined
  } catch {
    return undefined
  }
}

const LIVE: TaskState[] = ['running', 'blocked']

/**
 * Keeps the tasks table in step with one project's coordinator. The page's
 * own requests (answers, messages to a task) are matched to the coordinator's
 * replies by request id, held here while they are in flight.
 */
export class TaskStore {
  /** send_task_message request id → the task and the model and effort it asked for. */
  private messages = new Map<string, { taskId: string; model?: string; effort?: string }>()
  /** Tasks the page (`stop_task`) or the coordinator (TaskStop) asked to stop; any other stop is its process going away. */
  private stopAsked = new Set<string>()

  constructor(
    private db: Database,
    private now: () => number = Date.now,
  ) {}

  list(projectId: string): Task[] {
    return this.db.query('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as Task[]
  }

  get(projectId: string, id: string): Task | undefined {
    return (this.db.query('SELECT * FROM tasks WHERE project_id = ? AND id = ?').get(projectId, id) as Task | null) ?? undefined
  }

  events(taskId: string): TaskEvent[] {
    return this.db.query('SELECT * FROM task_events WHERE task_id = ? ORDER BY id').all(taskId) as TaskEvent[]
  }

  /** Per project: tasks, running ones (blocked included) and the ones waiting on the user. */
  counts(): Map<string, { tasks: number; running: number; needsYou: number }> {
    const rows = this.db
      .query(
        `SELECT project_id,
           count(*) AS tasks,
           sum(state IN ('running', 'blocked')) AS running,
           sum(state IN ('blocked', 'review')) AS needs
         FROM tasks GROUP BY project_id`,
      )
      .all() as { project_id: string; tasks: number; running: number; needs: number }[]
    return new Map(rows.map(r => [r.project_id, { tasks: r.tasks, running: r.running, needsYou: r.needs }]))
  }

  /** The user looked at a finished task: it is done. */
  review(projectId: string, id: string): Task | undefined {
    const task = this.get(projectId, id)
    if (!task || task.state !== 'review') return task
    this.patch(task, { state: 'done', reviewed_at: this.now() })
    this.event(id, 'reviewed')
    return this.get(projectId, id)
  }

  /** Tasks still running when their process went away (`projectId` unset: every project, at server start). */
  stopLive(reason: 'exited' | 'restart', projectId?: string): void {
    const live = this.db
      .query(
        `SELECT * FROM tasks WHERE state IN ('running', 'blocked')${projectId ? ' AND project_id = ?' : ''}`,
      )
      .all(...(projectId ? [projectId] : [])) as Task[]
    for (const task of live) {
      this.patch(task, { state: 'stopped', stop_reason: reason, approval_id: null, finished_at: this.now() })
      this.event(task.id, 'stopped', { reason })
    }
  }

  /** One line of the coordinator's stdout. */
  fromChild(projectId: string, sessionId: string, line: string): void {
    if (line.includes('"subtype":"task_')) return this.taskEvent(projectId, sessionId, line)
    if (line.includes('"name":"TaskStop"')) {
      const message = parseLine(line)?.message
      const content = isObj(message) && Array.isArray(message.content) ? message.content : []
      for (const block of content) {
        const taskId = isObj(block) && block.name === 'TaskStop' && isObj(block.input) ? str(block.input.task_id) : undefined
        if (taskId) this.stopAsked.add(taskId)
      }
      return
    }
    if (line.includes('"type":"control_request"')) {
      const msg = parseLine(line)
      const request = isObj(msg?.request) ? msg.request : {}
      const agentId = str(request.agent_id)
      const requestId = str(msg?.request_id)
      if (request.subtype !== 'can_use_tool' || !agentId || !requestId) return
      const task = this.get(projectId, agentId)
      if (!task || !LIVE.includes(task.state)) return
      this.patch(task, { state: 'blocked', approval_id: requestId })
      this.event(task.id, 'approval', { tool: str(request.tool_name) })
      return
    }
    if (line.includes('"type":"control_cancel_request"')) {
      const requestId = str(parseLine(line)?.request_id)
      if (requestId) this.answered(projectId, requestId)
      return
    }
    if (line.includes('"type":"control_response"')) {
      const response = parseLine(line)?.response
      if (!isObj(response)) return
      const requestId = str(response.request_id) ?? ''
      const sent = this.messages.get(requestId)
      if (!sent) return
      this.messages.delete(requestId)
      const task = this.get(projectId, sent.taskId)
      if (!task || response.subtype !== 'success') return
      const delivery = str(isObj(response.response) ? response.response.delivery : undefined)
      this.event(task.id, 'message', { delivery })
      if (delivery !== 'resumed') return
      // Resuming a task this process still holds starts no `task_started`.
      this.patch(task, {
        ...(LIVE.includes(task.state) ? {} : { state: 'running', started_at: this.now() }),
        stop_reason: null,
        error: null,
        finished_at: null,
        ...(sent.model && { model: sent.model }),
        ...(sent.effort && { effort: sent.effort }),
      })
    }
  }

  /** One line the page wrote to the coordinator. */
  fromClient(projectId: string, line: string): void {
    if (!line.includes('"control_')) return
    const msg = parseLine(line)
    if (msg?.type === 'control_response') {
      const response = isObj(msg.response) ? msg.response : {}
      const requestId = str(response.request_id)
      if (requestId) this.answered(projectId, requestId)
      return
    }
    const request = isObj(msg?.request) ? msg.request : {}
    const requestId = str(msg?.request_id)
    const taskId = str(request.task_id)
    if (msg?.type === 'control_request' && request.subtype === 'stop_task' && taskId) {
      this.stopAsked.add(taskId)
      return
    }
    if (msg?.type !== 'control_request' || request.subtype !== 'send_task_message' || !requestId || !taskId) return
    if (!this.get(projectId, taskId)) return
    this.messages.set(requestId, { taskId, model: str(request.model), effort: str(request.effort) })
  }

  private answered(projectId: string, requestId: string): void {
    const task = this.db
      .query('SELECT * FROM tasks WHERE project_id = ? AND approval_id = ?')
      .get(projectId, requestId) as Task | null
    if (task) this.patch(task, { state: 'running', approval_id: null })
  }

  private taskEvent(projectId: string, sessionId: string, line: string): void {
    const msg = parseLine(line)
    const id = str(msg?.task_id)
    if (!msg || msg.type !== 'system' || !id) return
    const now = this.now()
    const task = this.get(projectId, id)
    const usage = isObj(msg.usage) ? msg.usage : {}
    const metered = {
      ...(num(usage.total_tokens) !== undefined && { tokens: num(usage.total_tokens) }),
      ...(num(usage.tool_uses) !== undefined && { tool_uses: num(usage.tool_uses) }),
      ...(num(usage.duration_ms) !== undefined && { duration_ms: num(usage.duration_ms) }),
    }
    switch (msg.subtype) {
      case 'task_started': {
        // Only the coordinator's own workers; their workflows, shells and subagents are not tasks.
        if ((str(msg.task_type) ?? 'local_agent') !== 'local_agent' || (num(msg.spawn_depth) ?? 1) > 1) return
        if (task) {
          this.patch(task, {
            state: 'running',
            stop_reason: null,
            error: null,
            approval_id: null,
            started_at: now,
            finished_at: null,
          })
        } else {
          this.db.run(
            `INSERT INTO tasks (id, project_id, session_id, agent_id, tool_use_id, title, brief, subagent_type, state, created_at, updated_at, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
            [
              id,
              projectId,
              sessionId,
              id,
              str(msg.tool_use_id) ?? null,
              str(msg.description) ?? '',
              str(msg.prompt) ?? '',
              str(msg.subagent_type) ?? null,
              now,
              now,
              now,
            ],
          )
        }
        this.event(id, 'started')
        return
      }
      case 'task_progress': {
        if (!task) return
        this.patch(task, {
          ...metered,
          ...(str(msg.last_tool_name) && { last_tool: str(msg.last_tool_name) }),
          ...(str(msg.summary) && { summary: str(msg.summary) }),
        })
        return
      }
      case 'task_updated': {
        const patch = isObj(msg.patch) ? msg.patch : {}
        if (task && str(patch.error)) this.patch(task, { error: str(patch.error) })
        return
      }
      case 'task_notification': {
        if (!task) return
        const status = str(msg.status)
        const summary = str(msg.summary) || null
        if (status === 'completed') {
          this.patch(task, { ...metered, state: 'review', summary, approval_id: null, finished_at: now, reviewed_at: null })
          this.event(id, 'finished', { status })
        } else if (status === 'failed' || status === 'stopped' || status === 'killed') {
          // Already stopped: the server stopping its coordinators marked it first.
          if (!LIVE.includes(task.state)) return
          const reason: StopReason = status === 'failed' ? 'failed' : this.stopAsked.delete(id) ? 'user' : 'exited'
          this.patch(task, {
            ...metered,
            state: 'stopped',
            stop_reason: reason,
            ...(reason === 'failed' && { error: summary }),
            approval_id: null,
            finished_at: now,
          })
          this.event(id, 'stopped', { reason })
        }
      }
    }
  }

  private patch(task: Task, patch: Partial<Task>): void {
    const keys = Object.keys(patch) as (keyof Task)[]
    this.db.run(
      `UPDATE tasks SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND project_id = ?`,
      [...keys.map(k => (patch[k] ?? null) as string | number | null), this.now(), task.id, task.project_id],
    )
  }

  private event(taskId: string, kind: TaskEvent['kind'], payload?: Json): void {
    this.db.run('INSERT INTO task_events (task_id, ts, kind, payload) VALUES (?, ?, ?, ?)', [
      taskId,
      this.now(),
      kind,
      payload ? JSON.stringify(payload) : null,
    ])
  }
}

/** The worker's tokens as its progress reports them: the latest call's input and output. */
export function transcriptTokens(messages: Record<string, unknown>[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    const usage = message.type === 'assistant' && isObj(message.message) ? message.message.usage : undefined
    if (!isObj(usage)) continue
    return (
      (num(usage.input_tokens) ?? 0) +
      (num(usage.cache_creation_input_tokens) ?? 0) +
      (num(usage.cache_read_input_tokens) ?? 0) +
      (num(usage.output_tokens) ?? 0)
    )
  }
  return 0
}
