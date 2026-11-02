import { describe, expect, test } from 'bun:test'
import type { AgentTask, Tasks } from './agents'
import { groupTasks, mergeDetails, parseScreen, screenTail, spanClass, statusOf } from './background'

const task = (id: string, type: string, seq: number, status = 'running'): AgentTask => ({
  id,
  type,
  description: id,
  status,
  depth: 0,
  seq,
})

describe('background panes data', () => {
  test('mergeDetails reads the listing and keeps tasks it no longer lists', () => {
    const first = mergeDetails({}, {
      tasks: [
        { task_id: 't1', task_type: 'interactive_terminal', status: 'running', command: 'python3 -q', cols: 120, rows: 30, agent_id: 'a1', duration_ms: 1200 },
        { task_id: 'm1', task_type: 'local_bash', kind: 'monitor', status: 'running', command: 'tail -f x', events: [{ time: 5, text: 'ERROR' }, { bad: 1 }] },
        { task_id: 'b1', task_type: 'local_bash', kind: 'bash', status: 'completed', exit_code: 0, tail: 'done' },
        { status: 'running' },
      ],
    })
    expect(first.t1).toEqual({ id: 't1', status: 'running', command: 'python3 -q', cols: 120, rows: 30, agentId: 'a1', durationMs: 1200 })
    expect(first.m1?.events).toEqual([{ time: 5, text: 'ERROR' }, { time: 0, text: '' }])
    expect(first.b1).toMatchObject({ kind: 'bash', exitCode: 0, tail: 'done' })
    expect(Object.keys(first)).toHaveLength(3)
    const next = mergeDetails(first, { tasks: [{ task_id: 't1', status: 'killed' }] })
    expect(next.t1?.status).toBe('killed')
    expect(next.b1).toBe(first.b1)
    expect(mergeDetails(first, 'garbage')).toEqual(first)
  })

  test('parseScreen keeps spans, colors and bold; screenTail drops trailing blank rows', () => {
    const screen = parseScreen({
      output: 'x',
      screen: { cols: 80, rows: 4, lines: [[{ text: '$ ', fg: 32 }, { text: 'ls' }], [{ text: 'B', fg: 94, bold: true }], [], [{ text: '   ' }]] },
    })!
    expect(screen.lines[0]).toEqual([{ text: '$ ', fg: 32 }, { text: 'ls' }])
    expect(screenTail(screen)).toHaveLength(2)
    expect(screenTail(screen, 1)).toEqual([[{ text: 'B', fg: 94, bold: true }]])
    expect(parseScreen({ output: 'plain' })).toBeUndefined()
    expect(spanClass({ text: 'a', fg: 31 })).toBe('f31')
    expect(spanClass({ text: 'a', fg: 94, bold: true })).toBe('f94 f1')
    expect(spanClass({ text: 'a', fg: 38 })).toBeUndefined()
    expect(spanClass({ text: 'a' })).toBeUndefined()
  })

  test('groupTasks splits terminals, monitors and background shells in start order', () => {
    const tasks: Tasks = {
      b2: task('b2', 'local_bash', 3),
      t1: task('t1', 'interactive_terminal', 0),
      m1: task('m1', 'local_bash', 1),
      mcp: task('mcp', 'monitor_mcp', 2),
      a1: task('a1', 'local_agent', 4),
      d1: task('d1', 'dream', 5),
    }
    const groups = groupTasks(tasks, { m1: { id: 'm1', kind: 'monitor', status: 'running' } })
    expect(groups.terminals.map(x => x.id)).toEqual(['t1'])
    expect(groups.monitors.map(x => x.id)).toEqual(['m1', 'mcp'])
    expect(groups.background.map(x => x.id)).toEqual(['b2', 'd1'])
  })

  test('a finished status from the listing wins over a stale event', () => {
    expect(statusOf(task('x', 'local_bash', 0, 'running'), { id: 'x', status: 'killed' })).toBe('killed')
    expect(statusOf(task('x', 'local_bash', 0, 'completed'), { id: 'x', status: 'running' })).toBe('completed')
    expect(statusOf(task('x', 'local_bash', 0, 'running'))).toBe('running')
  })
})
