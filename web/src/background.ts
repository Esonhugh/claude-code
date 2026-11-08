// Terminals, Monitor and Background Tasks: what the fork-only
// `get_background_tasks` and `get_task_output` (format "screen") return, laid
// over the task map folded from the task_* events.

import { type AgentTask, isFinished, type Tasks } from './agents'
import type { Item } from './protocol'

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export type MonitorEvent = { time: number; text: string }

export type TaskDetail = {
  id: string
  kind?: 'bash' | 'monitor'
  status: string
  durationMs?: number
  command?: string
  cols?: number
  rows?: number
  exitCode?: number
  agentId?: string
  tail?: string
  events?: MonitorEvent[]
}

export type Details = Record<string, TaskDetail>

/** Merges a `get_background_tasks` reply; tasks it no longer lists keep their last detail. */
export function mergeDetails(prev: Details, body: unknown): Details {
  const rows = isObj(body) && Array.isArray(body.tasks) ? body.tasks.filter(isObj) : []
  const next = { ...prev }
  for (const row of rows) {
    const id = str(row.task_id)
    if (!id) continue
    const kind = row.kind === 'monitor' || row.kind === 'bash' ? row.kind : undefined
    next[id] = {
      id,
      status: str(row.status) ?? 'running',
      ...(kind && { kind }),
      ...(num(row.duration_ms) !== undefined && { durationMs: num(row.duration_ms) }),
      ...(num(row.cols) !== undefined && { cols: num(row.cols) }),
      ...(num(row.rows) !== undefined && { rows: num(row.rows) }),
      ...(num(row.exit_code) !== undefined && { exitCode: num(row.exit_code) }),
      ...(str(row.command) !== undefined && { command: str(row.command) }),
      ...(str(row.agent_id) && { agentId: str(row.agent_id) }),
      ...(str(row.tail) !== undefined && { tail: str(row.tail) }),
      ...(Array.isArray(row.events) && {
        events: row.events
          .filter(isObj)
          .map(e => ({ time: num(e.time) ?? 0, text: str(e.text) ?? '' })),
      }),
    }
  }
  return next
}

export type ScreenSpan = { text: string; fg?: number; bold?: boolean }

export type Screen = { cols: number; rows: number; lines: ScreenSpan[][] }

/** The structured screen from a `get_task_output` reply sent with `format: "screen"`. */
export function parseScreen(body: unknown): Screen | undefined {
  const screen = isObj(body) && isObj(body.screen) ? body.screen : undefined
  if (!screen || !Array.isArray(screen.lines)) return undefined
  return {
    cols: num(screen.cols) ?? 0,
    rows: num(screen.rows) ?? 0,
    lines: screen.lines.map(line =>
      (Array.isArray(line) ? line : []).filter(isObj).map(span => ({
        text: str(span.text) ?? '',
        ...(num(span.fg) !== undefined && { fg: num(span.fg) }),
        ...(span.bold === true && { bold: true }),
      })),
    ),
  }
}

/** The last `count` lines up to the last one with text, like the prototype's screen. */
export function screenTail(screen: Screen, count = 14): ScreenSpan[][] {
  let end = screen.lines.length
  while (end > 0 && !screen.lines[end - 1]!.some(span => span.text.trim())) end--
  return screen.lines.slice(Math.max(0, end - count), end)
}

/** CSS classes for a span: `f31` … `f97` for the SGR color, `f1` for bold. */
export function spanClass(span: ScreenSpan): string | undefined {
  const fg = span.fg !== undefined && ((span.fg >= 30 && span.fg <= 37) || (span.fg >= 90 && span.fg <= 97))
  return [fg && `f${span.fg}`, span.bold && 'f1'].filter(Boolean).join(' ') || undefined
}

/** The task's status: a finished status from the detail wins over a stale event. */
export function statusOf(task: AgentTask, detail?: TaskDetail): string {
  return detail && ['completed', 'failed', 'killed', 'stopped'].includes(detail.status) ? detail.status : task.status
}

export function isRunning(task: AgentTask, detail?: TaskDetail): boolean {
  return !isFinished({ ...task, status: statusOf(task, detail) })
}

export type Groups = { terminals: AgentTask[]; monitors: AgentTask[]; background: AgentTask[] }

/** Splits the task map into the three panes; a shell is a monitor once its detail says so. */
export function groupTasks(tasks: Tasks, details: Details): Groups {
  const groups: Groups = { terminals: [], monitors: [], background: [] }
  for (const task of Object.values(tasks).sort((a, b) => a.seq - b.seq)) {
    if (task.type === 'interactive_terminal') groups.terminals.push(task)
    else if (task.type === 'monitor_mcp' || (task.type === 'local_bash' && details[task.id]?.kind === 'monitor')) {
      groups.monitors.push(task)
    } else if (task.type === 'local_bash' || task.type === 'dream') groups.background.push(task)
  }
  return groups
}

export type Pane = 'workflow' | 'terminals' | 'monitor' | 'bg'

/**
 * The on-demand panes this session has used: a task of that kind (live or
 * ended), or the tool call that starts one in the history, so a reloaded
 * session keeps them.
 */
export function usedPanes(tasks: Tasks, items: Item[], groups: Groups): Pane[] {
  const used = new Set<Pane>()
  if (Object.values(tasks).some(task => task.type === 'local_workflow')) used.add('workflow')
  if (groups.terminals.length) used.add('terminals')
  if (groups.monitors.length) used.add('monitor')
  if (groups.background.length) used.add('bg')
  for (const item of items) {
    if (item.kind !== 'assistant') continue
    for (const block of item.blocks) {
      if (block?.kind !== 'tool') continue
      if (block.name === 'Workflow') used.add('workflow')
      else if (block.name === 'Tmux' || block.name === 'Terminal') used.add('terminals')
      else if (block.name === 'Monitor') used.add('monitor')
      else if (block.name === 'Bash' && /"run_in_background":true/.test(block.input)) used.add('bg')
    }
  }
  return (['workflow', 'terminals', 'monitor', 'bg'] as const).filter(pane => used.has(pane))
}

/** HH:MM:SS of an event, in local time. */
export function clockTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8)
}
