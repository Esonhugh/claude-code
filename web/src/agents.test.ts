import { describe, expect, it } from 'bun:test'
import { currentPhase, groupTasks, reduceTasks, type Tasks } from './agents'
import { initialState, reduce } from './protocol'

const sys = (subtype: string, rest: Record<string, unknown>) => ({
  type: 'system',
  subtype,
  session_id: 's',
  uuid: 'u',
  ...rest,
})

describe('agent tasks', () => {
  it('follows a subagent from start to notification', () => {
    let tasks: Tasks = {}
    tasks = reduceTasks(
      tasks,
      sys('task_started', {
        task_id: 'a1',
        tool_use_id: 'toolu_1',
        description: 'Research',
        subagent_type: 'Explore',
        task_type: 'local_agent',
        spawn_depth: 1,
      }),
    )
    tasks = reduceTasks(
      tasks,
      sys('task_progress', {
        task_id: 'a1',
        description: 'Research',
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 4000 },
        last_tool_name: 'Read',
      }),
    )
    expect(tasks.a1).toMatchObject({
      status: 'running',
      subagentType: 'Explore',
      depth: 1,
      tokens: 1200,
      lastTool: 'Read',
      toolUseId: 'toolu_1',
    })
    tasks = reduceTasks(
      tasks,
      sys('task_notification', {
        task_id: 'a1',
        status: 'completed',
        output_file: '/tmp/out.txt',
        summary: 'Found it',
      }),
    )
    expect(tasks.a1).toMatchObject({ status: 'completed', summary: 'Found it', outputFile: '/tmp/out.txt', lastTool: 'Read' })
    expect(groupTasks(tasks)).toEqual({ running: [], finished: [tasks.a1!] })
  })

  it('builds workflow phases from the progress snapshot', () => {
    const tasks = reduceTasks(
      reduceTasks({}, sys('task_started', { task_id: 'w1', description: 'Plan', task_type: 'local_workflow', workflow_name: 'spec' })),
      sys('task_progress', {
        task_id: 'w1',
        description: 'Plan',
        usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
        workflow_progress: [
          { type: 'phase', index: 0, label: 'gather', status: 'completed', message: 'Collect' },
          { type: 'agent', index: 0, phaseIndex: 0, label: 'ag1', status: 'completed' },
          { type: 'phase', index: 1, label: 'write', status: 'running' },
          { type: 'agent', index: 0, phaseIndex: 1, label: 'ag2', status: 'running' },
          { type: 'agent', index: 1, phaseIndex: 1, label: 'ag3', status: 'pending' },
        ],
      }),
    )
    const phases = tasks.w1!.phases!
    expect(phases.map(p => [p.label, p.agents.map(a => a.label)])).toEqual([
      ['gather', ['ag1']],
      ['write', ['ag2', 'ag3']],
    ])
    expect(currentPhase(phases)).toBe(1)
  })

  it('marks tasks missing from a background snapshot as ended and adds new ones', () => {
    let tasks = reduceTasks({}, sys('task_started', { task_id: 'a1', description: 'x' }))
    tasks = reduceTasks(tasks, sys('background_tasks_changed', { tasks: [{ task_id: 'b2', task_type: 'local_bash', description: 'npm test' }] }))
    expect(tasks.a1!.status).toBe('completed')
    expect(tasks.b2).toMatchObject({ status: 'running', type: 'local_bash' })
  })

  it('a resumed task runs again and the chat state carries tasks', () => {
    let state = reduce(initialState, sys('task_started', { task_id: 'a1', description: 'x' }))
    state = reduce(state, sys('task_updated', { task_id: 'a1', patch: { status: 'completed' } }))
    expect(state.tasks.a1!.status).toBe('completed')
    state = reduce(state, sys('task_started', { task_id: 'a1', description: 'x' }))
    expect(state.tasks.a1!.status).toBe('running')
    expect(state.items).toEqual([])
  })
})
