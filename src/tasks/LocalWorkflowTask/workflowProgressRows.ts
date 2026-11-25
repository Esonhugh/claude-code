// A workflow run's progress rows, kept and sent to SDK hosts the way official
// 2.1.329 does: every agent() call and phase is a row keyed by its index, rows
// are batched for 16ms, and each task_progress carries all rows so far. An
// agent the workflow does not wait for ends with the run.

import type { SdkWorkflowAgentProgress, SdkWorkflowProgress } from '../../types/tools.js'
import { emitTaskProgress } from '../../utils/task/sdkProgress.js'

export const WORKFLOW_END_AGENT_ERRORS = {
  killed: 'Stopped because the workflow was stopped',
  failed: 'Stopped because the workflow failed',
  completed: 'Stopped because the workflow finished without waiting for it',
} as const

const BATCH_MS = 16
// A batch of agent activity alone resends the rows at most this often.
const ACTIVITY_ROWS_MS = 10_000
const PREVIEW_CHARS = 400

type WorkflowRun = {
  toolUseId?: string
  description: string
  summary?: string
  startTime: number
  rows: SdkWorkflowProgress[]
  startedIndexes: Set<number>
  pending: SdkWorkflowProgress[]
  timer?: ReturnType<typeof setTimeout>
  rowsSentAt: number
}

const runs = new Map<string, WorkflowRun>()

/** A prompt or result as a row shows it: trimmed, at most 400 characters. */
export function workflowRowPreview(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').trim()
  if (!text) return undefined
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}\u2026` : text
}

/** Whether a row stands for an agent that started (not one still waiting for a slot). */
function hasStarted(row: SdkWorkflowAgentProgress): boolean {
  return row.startedAt !== undefined || row.queuedAt === undefined || (row.tokens ?? 0) > 0
}

export function startWorkflowProgressRows(
  taskId: string,
  run: { toolUseId?: string; description: string; summary?: string; startTime: number },
): void {
  stopBatch(runs.get(taskId))
  runs.set(taskId, { ...run, rows: [], startedIndexes: new Set(), pending: [], rowsSentAt: 0 })
}

export function reportWorkflowProgressRow(taskId: string, row: SdkWorkflowProgress): void {
  const run = runs.get(taskId)
  if (!run) return
  run.pending.push(row)
  run.timer ??= setTimeout(() => flush(taskId), BATCH_MS)
}

function stopBatch(run: WorkflowRun | undefined): void {
  if (run?.timer) clearTimeout(run.timer)
  if (run) run.timer = undefined
}

function totals(rows: SdkWorkflowProgress[]): { tokens: number; toolCalls: number } {
  let tokens = 0
  let toolCalls = 0
  for (const row of rows) {
    if (row.type !== 'workflow_agent') continue
    tokens += row.tokens ?? 0
    toolCalls += row.toolCalls ?? 0
  }
  return { tokens, toolCalls }
}

function flush(taskId: string): void {
  const run = runs.get(taskId)
  if (!run) return
  stopBatch(run)
  const batch = run.pending
  run.pending = []
  if (batch.length === 0) return
  const rows = [...run.rows]
  for (const row of batch) {
    if (row.type === 'workflow_agent' && hasStarted(row)) run.startedIndexes.add(row.index)
    const at = rows.findIndex(current => current.type === row.type && current.index === row.index)
    if (at === -1) rows.push(row)
    else rows[at] = row
  }
  run.rows = rows
  const agent = batch.findLast(row => row.type === 'workflow_agent')
  const now = Date.now()
  const withRows =
    !batch.every(row => row.type === 'workflow_agent' && row.state === 'progress') ||
    now - run.rowsSentAt >= ACTIVITY_ROWS_MS
  if (withRows) run.rowsSentAt = now
  const { tokens, toolCalls } = totals(rows)
  emitTaskProgress({
    taskId,
    toolUseId: run.toolUseId,
    description: agent
      ? agent.phaseTitle
        ? `${agent.phaseTitle}: ${agent.label}`
        : agent.label
      : run.description,
    startTime: run.startTime,
    totalTokens: tokens,
    toolUses: toolCalls,
    lastToolName: agent?.label,
    summary: run.summary,
    workflowProgress: withRows ? rows : undefined,
  })
}

/**
 * The run ended: rows still batched are sent, then an agent still running
 * reads as stopped with the run in one last task_progress. A paused run
 * sends nothing more. Later rows of this run are dropped.
 */
export function endWorkflowProgressRows(
  taskId: string,
  status: keyof typeof WORKFLOW_END_AGENT_ERRORS | 'paused',
): void {
  const run = runs.get(taskId)
  if (!run) return
  flush(taskId)
  runs.delete(taskId)
  if (status === 'paused') return
  let ended = false
  const rows = run.rows.map(row => {
    if (
      row.type !== 'workflow_agent' ||
      (row.state !== 'start' && row.state !== 'progress') ||
      !(hasStarted(row) || run.startedIndexes.has(row.index))
    ) {
      return row
    }
    ended = true
    return {
      ...row,
      state: 'error' as const,
      error: WORKFLOW_END_AGENT_ERRORS[status],
      endedWithRun: status === 'killed' ? 'stopped' : status,
    }
  })
  if (!ended) return
  const { tokens, toolCalls } = totals(rows)
  emitTaskProgress({
    taskId,
    toolUseId: run.toolUseId,
    description: run.description,
    startTime: run.startTime,
    totalTokens: tokens,
    toolUses: toolCalls,
    summary: run.summary,
    workflowProgress: rows,
  })
}
