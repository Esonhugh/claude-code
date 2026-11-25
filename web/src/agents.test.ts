import { describe, expect, it } from 'bun:test'
import {
  buildTeam,
  currentPhase,
  runningPhases,
  groupTasks,
  reduceTasks,
  type Tasks,
  unresolvedIssuers,
  agentOutput,
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

  it('keeps the name the agent started with when a progress summary arrives', () => {
    let tasks = reduceTasks({}, sys('task_started', { task_id: 'a1', description: 'Waiter', subagent_type: 'general-purpose' }))
    // An agent summary reports its activity as the progress description.
    tasks = reduceTasks(tasks, sys('task_progress', { task_id: 'a1', description: 'Running sleep 60', summary: 'Running sleep 60', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }))
    expect(tasks.a1).toMatchObject({ description: 'Waiter', summary: 'Running sleep 60' })
    // A page that attaches late may see progress first; that still names the row.
    expect(reduceTasks({}, sys('task_progress', { task_id: 'b1', description: 'Late' })).b1!.description).toBe('Late')
  })

  // Rows as official 2.1.329 sends them: phases first, then one row per agent() call.
  const rows = [
    { type: 'workflow_phase', index: 1, title: 'gather' },
    { type: 'workflow_phase', index: 2, title: 'write' },
    { type: 'workflow_agent', index: 1, phaseIndex: 1, phaseTitle: 'gather', label: 'ag1', agentId: 'a1', state: 'done', startedAt: 1, tokens: 50, toolCalls: 2, durationMs: 900 },
    { type: 'workflow_agent', index: 2, phaseIndex: 2, phaseTitle: 'write', label: 'ag2', agentId: 'a2', state: 'progress', startedAt: 2, queuedAt: 1, tokens: 10, lastToolName: 'Read' },
    { type: 'workflow_agent', index: 3, phaseIndex: 2, phaseTitle: 'write', label: 'ag3', state: 'start', queuedAt: 1 },
  ]
  const progress = (workflow_progress?: unknown[]) =>
    sys('task_progress', { task_id: 'w1', tool_use_id: 'toolu_wf', description: 'Plan', usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 }, workflow_progress })

  it('builds workflow phases from the progress rows', () => {
    let tasks = reduceTasks({}, sys('task_started', { task_id: 'w1', description: 'Plan', task_type: 'local_workflow', workflow_name: 'spec' }))
    tasks = reduceTasks(tasks, progress(rows))
    const phases = tasks.w1!.phases!
    expect(phases.map(p => [p.label, p.status, p.agents.map(a => [a.label, a.status])])).toEqual([
      ['gather', 'completed', [['ag1', 'completed']]],
      ['write', 'running', [['ag2', 'running'], ['ag3', 'queued']]],
    ])
    expect(currentPhase(phases)).toBe(1)
    // Agent activity alone comes without rows; the phases stay.
    expect(reduceTasks(tasks, progress()).w1!.phases).toEqual(phases)
  })

  it('a stopped workflow ends the phases and agents that were still running', () => {
    let tasks = reduceTasks({}, sys('task_started', { task_id: 'w1', description: 'Plan', task_type: 'local_workflow' }))
    tasks = reduceTasks(tasks, progress(rows))
    // The last rows end the started agent with the run; the queued one gets none.
    const stopped = { ...rows[3], state: 'error', error: 'Stopped because the workflow was stopped', endedWithRun: 'stopped' }
    tasks = reduceTasks(tasks, progress([...rows.slice(0, 3), stopped, rows[4]]))
    tasks = reduceTasks(tasks, sys('task_notification', { task_id: 'w1', status: 'stopped' }))
    expect(tasks.w1!.phases!.map(p => [p.status, p.agents.map(a => a.status)])).toEqual([
      ['completed', ['completed']],
      ['stopped', ['stopped', 'stopped']],
    ])
  })

  it('a failed agent fails its phase', () => {
    let tasks = reduceTasks({}, sys('task_started', { task_id: 'w1', description: 'Plan', task_type: 'local_workflow' }))
    tasks = reduceTasks(tasks, progress([rows[0], { ...rows[2], state: 'error', error: 'boom' }]))
    expect(tasks.w1!.phases!.map(p => [p.status, p.agents.map(a => a.status)])).toEqual([['failed', ['failed']]])
  })

  it('a workflow card follows the agent its row names', () => {
    let tasks = reduceTasks({}, sys('task_started', { task_id: 'w1', task_type: 'local_workflow', tool_use_id: 'toolu_wf', description: 'Plan' }))
    tasks = reduceTasks(tasks, progress(rows))
    expect(workflowAgent(tasks.w1!, 'ag2')).toMatchObject({ id: 'a2', status: 'running', tokens: 10, lastTool: 'Read', toolUseId: 'toolu_wf' })
    expect(workflowAgent(tasks.w1!, 'ag1')).toMatchObject({ id: 'a1', status: 'completed', toolUses: 2, durationMs: 900 })
    // Still waiting for a slot: no transcript yet.
    expect(workflowAgent(tasks.w1!, 'ag3')).toBeUndefined()
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
  })

  it("an agent's output is its structured output, else its last reply", () => {
    const say = (...content: Record<string, unknown>[]) => ({ type: 'assistant', message: { content } })
    expect(agentOutput([])).toBeUndefined()
    expect(agentOutput([say({ type: 'text', text: 'first' }), { type: 'user' }, say({ type: 'text', text: 'last' })])).toEqual({ text: 'last', structured: false })
    expect(
      agentOutput([
        say({ type: 'tool_use', name: 'StructuredOutput', input: { claims: ['a'] } }),
        { type: 'user' },
        say({ type: 'text', text: 'Done.' }),
      ]),
    ).toEqual({ text: '{\n  "claims": [\n    "a"\n  ]\n}', structured: true })
  })

  it('the current phase is the latest one running, so pipelined phases move it on', () => {
    const phase = (index: number, status: string) => ({ index, label: `p${index}`, status, agents: [] })
    expect(currentPhase([phase(0, 'completed'), phase(1, 'running'), phase(2, 'running'), phase(3, 'pending')])).toBe(2)
    expect(currentPhase([phase(0, 'completed'), phase(1, 'pending')])).toBe(1)
    expect(currentPhase([phase(0, 'completed'), phase(1, 'completed')])).toBe(1)
    expect(runningPhases([phase(0, 'completed'), phase(1, 'running'), phase(2, 'running'), phase(3, 'pending')])).toEqual([1, 2])
    expect(runningPhases([phase(0, 'completed'), phase(1, 'pending')])).toEqual([1])
    expect(runningPhases([])).toEqual([])
    // One failed agent fails the phase, but its other agents still run.
    const failedButBusy = { ...phase(1, 'failed'), agents: [{ label: 'a', status: 'failed' }, { label: 'b', status: 'running' }] }
    expect(currentPhase([phase(0, 'completed'), failedButBusy, phase(2, 'pending')])).toBe(1)
    expect(runningPhases([phase(0, 'completed'), failedButBusy, phase(2, 'pending')])).toEqual([1])
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

    // The engine's flag shows idle at once, before the lead reads the notification, and working again.
    const idle = reduce(later, sys('task_updated', { task_id: 'ta', patch: { is_idle: true } }))
    expect(buildTeam(idle.tasks, idle.items)!.members.map(m => m.state)).toEqual(['idle', 'idle'])
    const woken = reduce(idle, sys('task_updated', { task_id: 'tb', patch: { is_idle: false } }))
    expect(buildTeam(woken.tasks, woken.items)!.members.map(m => m.state)).toEqual(['idle', 'working'])
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

describe('agent meta line', () => {
  it('says "tok" once', async () => {
    const { taskMeta } = await import('./components/Agents')
    const task = { id: 'a', type: 'local_agent', status: 'completed', durationMs: 0, tokens: 1234 } as Parameters<typeof taskMeta>[0]
    expect(taskMeta(task)).toBe('0s · 1.2k tok')
  })
})
