import { describe, expect, it } from 'bun:test'
import {
  buildTeam,
  currentPhase,
  groupTasks,
  reduceTasks,
  type Tasks,
  unresolvedIssuers,
  workflowAgent,
} from './agents'
import { addUserMessage, initialState, reduce } from './protocol'

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
    expect(groupTasks(tasks)).toMatchObject({ running: [], finished: [tasks.a1!] })
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

  it('nests workflow agents and subagents under the task that started them', () => {
    let tasks: Tasks = {}
    for (const event of [
      { task_id: 'w1', task_type: 'local_workflow', tool_use_id: 'toolu_wf', description: 'Plan' },
      { task_id: 'wa', task_type: 'local_agent', tool_use_id: 'toolu_wf', description: 'spec: gather-a', spawn_depth: 1 },
      { task_id: 'p1', task_type: 'local_agent', tool_use_id: 'toolu_p', description: 'parent' },
      { task_id: 'c1', task_type: 'local_agent', tool_use_id: 'toolu_c', description: 'child', spawn_depth: 1 },
    ]) {
      tasks = reduceTasks(tasks, sys('task_started', event))
    }
    expect(unresolvedIssuers(tasks, {})).toEqual(['toolu_c'])
    const flat = groupTasks(tasks)
    expect(flat.running.map(t => t.id)).toEqual(['w1', 'p1', 'c1'])
    const nested = groupTasks(tasks, { toolu_c: 'p1' })
    expect(nested.running.map(t => t.id)).toEqual(['w1', 'p1'])
    expect(nested.children.get('p1')!.map(t => t.id)).toEqual(['c1'])
    expect(nested.children.has('w1')).toBe(false)
    expect(workflowAgent(tasks, tasks.w1!, 'gather-a')?.id).toBe('wa')
  })
})

describe('agent team', () => {
  const spawn = (id: string, name: string) => ({
    type: 'assistant',
    message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name: 'Agent', input: { name, prompt: `work ${name}` } }] },
  })
  const spawned = (id: string, name: string) => ({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Spawned successfully.\nagent_id: a${name}-0123\nname: ${name}` }] }],
    },
  })
  const teammatePrompt = (uuid: string, body: string) => ({
    type: 'user',
    isReplay: true,
    uuid,
    message: { role: 'user', content: `Another Claude session sent a message:\n${body}\n\nReply via SendMessage.` },
  })

  it('names members, folds teammate prompts and tracks who is idle', () => {
    const messages: unknown[] = [
      spawn('toolu_a', 'alice'),
      sys('task_started', { task_id: 'ta', task_type: 'in_process_teammate', tool_use_id: 'toolu_a', description: 'alice task' }),
      spawned('toolu_a', 'alice'),
      spawn('toolu_b', 'bob'),
      sys('task_started', { task_id: 'tb', task_type: 'in_process_teammate', tool_use_id: 'toolu_b', description: 'bob task' }),
      spawned('toolu_b', 'bob'),
      teammatePrompt(
        'u1',
        '<teammate-message teammate_id="alice" color="blue">\n{"type":"idle_notification","from":"alice","result":"ALICE_DONE"}\n</teammate-message>\n\n<teammate-message teammate_id="bob" color="green" summary="found a bug">\nThe results table is off by one.\n</teammate-message>',
      ),
      {
        type: 'assistant',
        message: { id: 'msg_s', content: [{ type: 'tool_use', id: 'toolu_s', name: 'SendMessage', input: { to: 'alice', message: 'Check section 2', summary: 'section 2' } }] },
      },
    ]
    const state = messages.reduce(reduce, initialState)
    expect(state.items.filter(i => i.kind === 'user')).toEqual([])
    expect(state.items.filter(i => i.kind === 'teammate')).toEqual([
      { kind: 'teammate', id: 'u1-0', from: 'alice', color: 'blue', text: '{"type":"idle_notification","from":"alice","result":"ALICE_DONE"}' },
      { kind: 'teammate', id: 'u1-1', from: 'bob', color: 'green', summary: 'found a bug', text: 'The results table is off by one.' },
    ])
    // Teammates live in the team, not in the task groups.
    expect(groupTasks(state.tasks).running).toEqual([])

    const team = buildTeam(state.tasks, state.items)!
    expect(team.members.map(m => [m.name, m.color, m.agentId, m.state])).toEqual([
      ['alice', 'blue', 'aalice-0123', 'working'],
      ['bob', 'green', 'abob-0123', 'working'],
    ])
    expect(team.events.map(e => [e.from, e.to, e.type, e.text])).toEqual([
      ['alice', 'team-lead', 'idle_notification', 'ALICE_DONE'],
      ['bob', 'team-lead', undefined, 'The results table is off by one.'],
      ['team-lead', 'alice', undefined, 'Check section 2'],
    ])

    const later = reduce(
      state,
      teammatePrompt('u2', '<teammate-message teammate_id="bob" color="green">\n{"type":"idle_notification","from":"bob"}\n</teammate-message>'),
    )
    expect(buildTeam(later.tasks, later.items)!.members.map(m => m.state)).toEqual(['working', 'idle'])
    expect(buildTeam({}, later.items)).toBeUndefined()
  })

  it('skips the echo of a message the page sent', () => {
    const sent = addUserMessage(initialState, 'hello', undefined, 'uuid-1')
    const echoed = reduce(sent, {
      type: 'user',
      isReplay: true,
      uuid: 'uuid-1',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(echoed.items).toEqual(sent.items)
  })
})
