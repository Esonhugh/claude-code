// A project's tasks: the workers its coordinator dispatched with the Agent
// tool (docs/design/claude-web-project.md 4.2). The server keeps them in its
// tasks table; the page adds what only it knows yet (a pending approval) and
// the running clock.

import { type AgentTask, formatTokens } from './agents'
import type { ProjectTask } from './api'
import type { MessageKey } from './i18n'
import { type Approval, type ChatState, type Item, sameTaskEnding, type TaskNote } from './protocol'

/** running · blocked (an unanswered approval) · review (finished, not looked at) · done · stopped. */
export type TaskState = ProjectTask['state']

/** The rows as the page shows them: a task whose worker asks for approval here is blocked. */
export function withApprovals(rows: ProjectTask[], approvals: Approval[]): ProjectTask[] {
  const asking = new Set(approvals.flatMap(a => (a.agentId ? [a.agentId] : [])))
  return rows.map(row => (asking.has(row.id) && row.state === 'running' ? { ...row, state: 'blocked' } : row))
}

/** Approvals the coordinator answers: its own, and its teammates', which are not tasks. */
export function coordinatorApprovals(rows: ProjectTask[], approvals: Approval[]): Approval[] {
  const tasks = new Set(rows.map(row => row.id))
  return approvals.filter(a => !a.agentId || !tasks.has(a.agentId))
}

export const isLive = (task: ProjectTask) => task.state === 'running' || task.state === 'blocked'

/** A task the user stopped stays stopped; any other can be messaged (an ended one resumes). */
export const canMessage = (task: ProjectTask) => !(task.state === 'stopped' && task.stop_reason === 'user')

export const TASK_GROUPS: { key: MessageKey; states: TaskState[] }[] = [
  { key: 'groupNeedsYou', states: ['blocked', 'review'] },
  { key: 'groupRunning', states: ['running'] },
  { key: 'groupEnded', states: ['done', 'stopped'] },
]

/** The kanban's columns. */
export const TASK_LANES: { key: MessageKey; states: TaskState[] }[] = [
  { key: 'groupRunning', states: ['running'] },
  { key: 'taskState_blocked', states: ['blocked'] },
  { key: 'taskState_review', states: ['review'] },
  { key: 'groupEnded', states: ['done', 'stopped'] },
]

/** `1m35s`, the prototype's `fmtT`. */
export function formatTaskTime(ms: number | undefined): string {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** How long the task has run: its last report, or the clock since its run started while it runs. */
export function taskElapsed(task: ProjectTask, now: number): number {
  return isLive(task) ? Math.max(task.duration_ms, (task.prior_ms ?? 0) + now - task.started_at) : task.duration_ms
}

/** `Opus 5.5 · 1m35s · 6.8k tok · WebFetch` (the tool only while it runs). */
export function taskMeta(task: ProjectTask, model: string | undefined, now: number): string {
  return [
    model,
    formatTaskTime(taskElapsed(task, now)),
    task.tokens > 0 ? formatTokens(task.tokens) : undefined,
    task.state === 'running' ? task.last_tool : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Which model the task runs on: the user's pick, the Agent call's, the project's, or the coordinator's. */
export function taskModel(
  task: ProjectTask,
  input: { model?: string } | undefined,
  workerModel: string | null,
  coordinatorModel: string | undefined,
): string | undefined {
  return task.model ?? input?.model ?? workerModel ?? coordinatorModel
}

export type AgentInput = { description?: string; prompt?: string; model?: string; name?: string }

/** The Agent call's input by tool use id, for a task's brief (`prompt`) and model. */
export function agentInputs(items: Item[]): Map<string, AgentInput> {
  const inputs = new Map<string, AgentInput>()
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block.kind !== 'tool' || block.name !== 'Agent') continue
      try {
        const input = JSON.parse(block.input) as Record<string, unknown>
        inputs.set(block.id, {
          ...(typeof input.description === 'string' && { description: input.description }),
          ...(typeof input.prompt === 'string' && { prompt: input.prompt }),
          ...(typeof input.model === 'string' && { model: input.model }),
          ...(typeof input.name === 'string' && { name: input.name }),
        })
      } catch {
        // Still streaming: name the task as soon as its whole description has arrived.
        const description = /^\s*\{\s*"description"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(block.input)?.[1]
        if (description) inputs.set(block.id, { description: JSON.parse(description) as string })
      }
    }
  }
  return inputs
}

/**
 * Whom a SendMessage call addressed: `to` (an agent id), and the tool use id
 * of the Agent call that gave the agent that name, when it is a name.
 */
export function messageTarget(input: string, inputs: Map<string, AgentInput>): { to: string; toolUseId?: string } | undefined {
  let to: unknown
  try {
    to = (JSON.parse(input) as { to?: unknown }).to
  } catch {
    return undefined
  }
  if (typeof to !== 'string' || !to) return undefined
  for (const [toolUseId, agent] of inputs) if (agent.name === to) return { to, toolUseId }
  return { to }
}

/** The notice line for a task that ended: key and variables. */
export function taskNoteText(
  note: TaskNote,
  task: Pick<AgentTask, 'description' | 'durationMs'> | undefined,
): { key: MessageKey; vars: Record<string, string> } {
  const title = task?.description ?? note.taskId
  if (note.status === 'completed') {
    return { key: 'taskFinishedNote', vars: { title, time: formatTaskTime(note.durationMs ?? task?.durationMs) } }
  }
  return { key: note.status === 'failed' ? 'taskFailedNote' : 'taskStoppedNote', vars: { title } }
}

/** Link only unambiguous SDK/history copies. A legacy XML line must not consume two runs. */
function taskCopies(logs: TaskNote[], live: TaskNote[]): Map<TaskNote, TaskNote> {
  const unique = new Map<TaskNote, TaskNote>()
  // Legacy evidence cannot make an exact match ambiguous or take its SDK copy.
  const matched = new Set<TaskNote>()
  for (const log of logs) {
    if (!log.runId) continue
    const copy = live.find(note => note.runId === log.runId && note.taskId === log.taskId)
    if (copy) {
      unique.set(log, copy)
      matched.add(copy)
    }
  }
  const counts = new Map<TaskNote, number>()
  for (const log of logs) {
    if (unique.has(log)) continue
    const candidates = live.filter(note => !matched.has(note) && sameTaskEnding(log, note, true))
    for (const note of candidates) counts.set(note, (counts.get(note) ?? 0) + 1)
    if (candidates.length === 1) unique.set(log, candidates[0]!)
  }
  for (const [log, note] of unique) if (!matched.has(note) && counts.get(note) !== 1) unique.delete(log)
  return unique
}

/** Main receives its direct workers and reports actually delivered to its transcript. */
export function coordinatorTaskNotes(chat: ChatState, rows: ProjectTask[] = []): TaskNote[] {
  const live = chat.taskNotes.filter(note => !note.inTranscript)
  const recorded = chat.taskNotes.filter(note => note.inTranscript)
  const copies = taskCopies(recorded, live)
  const logs = new Map(Array.from(copies, ([log, note]) => [note, log]))
  const isMain = (note: TaskNote) => note.notificationToMain || note.parentTaskId === null || (
    note.parentTaskId === undefined && note.runId && note.legacyProjectToolId &&
    note.toolUseId === note.legacyProjectToolId && rows.some(row => row.id === note.taskId && row.tool_use_id === note.toolUseId)
  )
  return chat.taskNotes.flatMap((note, i) => {
    if (note.inTranscript) {
      const copy = copies.get(note)
      if (copy) return chat.taskNotes.indexOf(copy) < i ? [] : [{ ...copy, ...note }]
      // A legacy log of repeated direct endings need not add an extra row if all its
      // possible copies are already shown here. Keep ambiguous owner fallback visible.
      const candidates = live.filter(ending => sameTaskEnding(note, ending, true))
      return candidates.length > 1 && candidates.every(isMain) &&
        recorded.filter(log => candidates.some(ending => sameTaskEnding(log, ending, true))).length <= candidates.length ? [] : [note]
    }
    const log = logs.get(note)
    if (log) return chat.taskNotes.indexOf(log) < i ? [] : [{ ...note, ...log }]
    return isMain(note) ? [note] : []
  })
}

/** Merge only this owner's live endings with its local transcript. Main reports win. */
export function workerTaskNotes(chat: ChatState, ownerId: string, history: ChatState): TaskNote[] {
  const live = chat.taskNotes.filter(note => !note.inTranscript)
  const mainLogs = chat.taskNotes.filter(note => note.inTranscript)
  const main = taskCopies(mainLogs, live)
  const promoted = new Set(main.values())
  const owned = live.filter(note => note.parentTaskId === ownerId)
  const copies = taskCopies(history.taskNotes, owned)
  const shadowed = new Set(copies.values())
  const toMain = (note: TaskNote) => note.notificationToMain || promoted.has(note)
  const recorded = history.taskNotes.filter(log => {
    // An identified main report also wins when only the two transcripts were replayed.
    if (log.runId && mainLogs.some(mainLog => mainLog.runId === log.runId && mainLog.taskId === log.taskId)) return false
    const note = copies.get(log)
    return !note || !toMain(note)
  })
  const byTool = new Map<string, string>()
  for (const item of history.items) {
    if (item.kind === 'assistant') for (const block of item.blocks) {
      if (block.kind === 'tool') byTool.set(block.id, item.id)
    }
  }
  return [...recorded, ...owned.filter(note => !toMain(note) && !shadowed.has(note)).map(note => ({
    ...note, afterId: note.toolUseId ? byTool.get(note.toolUseId) : undefined,
  }))]
}

/** Notes keyed by the item they follow; `''` holds the rest (their item is not shown), drawn last. */
export function notesByItem(notes: TaskNote[], items: Item[]): Map<string, TaskNote[]> {
  const ids = new Set(items.map(i => i.id))
  const out = new Map<string, TaskNote[]>()
  for (const note of notes) {
    const key = note.afterId && ids.has(note.afterId) ? note.afterId : ''
    out.set(key, [...(out.get(key) ?? []), note])
  }
  return out
}

/** The worker's conversation without its first prompt, which the task shows as its brief. */
export function workerItems(items: Item[], brief: string): Item[] {
  const first = items.findIndex(i => i.kind === 'user')
  return first !== -1 && items[first]!.kind === 'user' && (items[first] as { text: string }).text.trim() === brief.trim()
    ? items.filter((_, i) => i !== first)
    : items
}
