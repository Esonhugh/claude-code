// A project's tasks: the workers its coordinator dispatched with the Agent
// tool, folded from `system/task_*` (docs/design/claude-web-project.md 4.2).

import { type AgentTask, isFinished, type Tasks } from './agents'
import type { MessageKey } from './i18n'
import type { Item, TaskNote } from './protocol'

/** running · blocked (an unanswered approval) · review (finished, not looked at) · done · stopped. */
export type TaskState = 'running' | 'blocked' | 'review' | 'done' | 'stopped'

export function taskState(task: AgentTask, reviewed: ReadonlySet<string>): TaskState {
  if (!isFinished(task)) return 'running'
  if (task.status === 'completed') return reviewed.has(task.id) ? 'done' : 'review'
  return 'stopped'
}

/** The coordinator's own workers, in dispatch order. */
export function projectTasks(tasks: Tasks): AgentTask[] {
  return Object.values(tasks)
    // The coordinator's own Agent calls have spawn depth 1 (older engines leave it out).
    .filter(task => task.type === 'local_agent' && task.depth <= 1)
    .sort((a, b) => a.seq - b.seq)
}

export const TASK_GROUPS: { key: MessageKey; states: TaskState[] }[] = [
  { key: 'groupNeedsYou', states: ['blocked', 'review'] },
  { key: 'groupRunning', states: ['running'] },
  { key: 'groupEnded', states: ['done', 'stopped'] },
]

/** `1m35s`, the prototype's `fmtT`. */
export function formatTaskTime(ms: number | undefined): string {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** `Opus 5.5 · 1m35s · 6.8k tok · WebFetch` (the tool only while it runs). */
export function taskMeta(task: AgentTask, state: TaskState, model: string | undefined): string {
  return [
    model,
    formatTaskTime(task.durationMs),
    `${((task.tokens ?? 0) / 1000).toFixed(1)}k tok`,
    state === 'running' ? task.lastTool : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The Agent call's input by tool use id, for a task's brief (`prompt`). */
export function agentInputs(items: Item[]): Map<string, { description?: string; prompt?: string }> {
  const inputs = new Map<string, { description?: string; prompt?: string }>()
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block.kind !== 'tool' || block.name !== 'Agent') continue
      try {
        const input = JSON.parse(block.input) as Record<string, unknown>
        inputs.set(block.id, {
          ...(typeof input.description === 'string' && { description: input.description }),
          ...(typeof input.prompt === 'string' && { prompt: input.prompt }),
        })
      } catch {
        // Still streaming: the input is not whole yet.
      }
    }
  }
  return inputs
}

/** The notice line for a task that ended: key and variables. */
export function taskNoteText(note: TaskNote, task: AgentTask | undefined): { key: MessageKey; vars: Record<string, string> } {
  const title = task?.description ?? note.taskId
  if (note.status === 'completed') {
    return { key: 'taskFinishedNote', vars: { title, time: formatTaskTime(task?.durationMs) } }
  }
  return { key: note.status === 'failed' ? 'taskFailedNote' : 'taskStoppedNote', vars: { title } }
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
