import type { TaskState } from '../../tasks/types.js'

// Official 2.1.329: an agent row's tokenCount is read 300ms after it starts,
// then every 5s; the last 16 readings are kept.
const MAX_READINGS = 16
const READING_MS = 5000
const FIRST_READING_MS = 300

type Readings = { readings: number[]; dueAt: number }
type AgentTask = Pick<TaskState, 'id' | 'startTime'> & {
  evictAfter?: number
  progress?: { tokenCount: number }
}

const tokenReadings = new Map<string, Readings>()

export function isAgentTask(task: TaskState): boolean {
  return task.type === 'local_agent' || task.type === 'in_process_teammate'
}

// The readings due by `now`, each the count the task held until then.
function readingsAt(task: AgentTask, now: number): Readings {
  const stored = tokenReadings.get(task.id) ?? { readings: [], dueAt: task.startTime + FIRST_READING_MS }
  const due = Math.floor((now - stored.dueAt) / READING_MS) + 1
  if (!(due > 0)) return stored
  return {
    readings: [...stored.readings, ...Array<number>(Math.min(due, MAX_READINGS)).fill(task.progress?.tokenCount ?? 0)].slice(-MAX_READINGS),
    dueAt: stored.dueAt + due * READING_MS,
  }
}

export function startTokenReadings(taskId: string, now: number): void {
  tokenReadings.set(taskId, { readings: [], dueAt: now + FIRST_READING_MS })
}

/** Keeps the readings of an agent task across one update; they start over once its row goes. */
export function noteAgentTaskUpdate(before: AgentTask, after: AgentTask, now: number): void {
  if (before.evictAfter === 0 || after.evictAfter === 0) startTokenReadings(after.id, now)
  else if (before.progress?.tokenCount !== after.progress?.tokenCount) tokenReadings.set(after.id, readingsAt(before, now))
}

/** The last 16 readings, oldest first, ending with the count right now. */
export function getTokenSamples(task: AgentTask, now: number): number[] {
  const { readings, dueAt } = readingsAt(task, now)
  // A reading under half a period old gives way to the current count.
  const recent = now - (dueAt - READING_MS) < READING_MS / 2
  return [...(recent ? readings.slice(0, -1) : readings), task.progress?.tokenCount ?? 0].slice(-MAX_READINGS)
}

export function forgetTokenReadings(taskId: string): void {
  tokenReadings.delete(taskId)
}
