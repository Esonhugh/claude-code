import { describe, expect, it } from 'bun:test'
import { openProjectsDb, ProjectStore } from './projectsDb.js'
import { TaskStore, transcriptTokens } from './tasks.js'

const SESSION = '11111111-2222-4333-8444-555555555555'
const line = (m: Record<string, unknown>) => JSON.stringify(m)

function setup() {
  const db = openProjectsDb(':memory:')
  let clock = 1000
  const store = new TaskStore(db, () => clock)
  const project = new ProjectStore(db).create({
    name: 'P',
    cwd: '/tmp',
    instructions: '',
    worker_model: null,
    permission_mode: 'default',
  })
  const child = (m: Record<string, unknown>) => store.fromChild(project.id, SESSION, line(m))
  const client = (m: Record<string, unknown>) => store.fromClient(project.id, line(m))
  const started = (id: string, extra: Record<string, unknown> = {}) =>
    child({ type: 'system', subtype: 'task_started', task_id: id, description: `Task ${id}`, prompt: `brief ${id}`, task_type: 'local_agent', spawn_depth: 1, tool_use_id: `toolu_${id}`, ...extra })
  return { db, store, project, child, client, started, tick: (ms: number) => (clock += ms) }
}

describe('TaskStore', () => {
  it('keeps a task from start through progress to review and done', () => {
    const { store, project, child, started, tick } = setup()
    started('a1')
    // Not the coordinator's own workers: a nested agent and a workflow.
    started('nested', { spawn_depth: 2 })
    started('wf', { task_type: 'local_workflow' })
    expect(store.list(project.id).map(t => t.id)).toEqual(['a1'])
    expect(store.get(project.id, 'a1')).toMatchObject({
      title: 'Task a1',
      brief: 'brief a1',
      agent_id: 'a1',
      session_id: SESSION,
      tool_use_id: 'toolu_a1',
      state: 'running',
      started_at: 1000,
    })
    tick(5000)
    child({ type: 'system', subtype: 'task_progress', task_id: 'a1', usage: { total_tokens: 6800, tool_uses: 2, duration_ms: 41000 }, last_tool_name: 'WebFetch', summary: 'reading' })
    expect(store.get(project.id, 'a1')).toMatchObject({ tokens: 6800, tool_uses: 2, duration_ms: 41000, last_tool: 'WebFetch', summary: 'reading' })
    expect(store.counts().get(project.id)).toEqual({ tasks: 1, running: 1, needsYou: 0 })

    child({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'all done', usage: { total_tokens: 9100, tool_uses: 3, duration_ms: 95000 } })
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'review', summary: 'all done', tokens: 9100, duration_ms: 95000, finished_at: 6000 })
    expect(store.counts().get(project.id)).toEqual({ tasks: 1, running: 0, needsYou: 1 })

    expect(store.review(project.id, 'a1')).toMatchObject({ state: 'done', reviewed_at: 6000 })
    expect(store.events('a1').map(e => e.kind)).toEqual(['started', 'finished', 'reviewed'])
  })

  it('blocks a task on its worker\'s approval until the page answers or the request is cancelled', () => {
    const { store, project, child, client, started } = setup()
    started('a1')
    started('a2')
    child({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, agent_id: 'a1' } })
    // The coordinator's own requests are not a task's.
    child({ type: 'control_request', request_id: 'r0', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } })
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'blocked', approval_id: 'r1' })
    expect(store.counts().get(project.id)).toEqual({ tasks: 2, running: 2, needsYou: 1 })
    client({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow' } } })
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'running', approval_id: null })

    child({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, agent_id: 'a2' } })
    child({ type: 'control_cancel_request', request_id: 'r2' })
    expect(store.get(project.id, 'a2')).toMatchObject({ state: 'running', approval_id: null })
  })

  it('marks stopped and failed tasks with their reason', () => {
    const { store, project, child, client, started } = setup()
    for (const id of ['a1', 'a2', 'a3', 'a4']) started(id)
    client({ type: 'control_request', request_id: 's1', request: { subtype: 'stop_task', task_id: 'a1' } })
    child({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'TaskStop', input: { task_id: 'a3' } }] } })
    const ended = (id: string, status: string, summary?: string) => child({ type: 'system', subtype: 'task_notification', task_id: id, status, summary })
    ended('a1', 'stopped', 'Agent "x" was stopped')
    ended('a2', 'failed', 'boom')
    ended('a3', 'killed')
    // Killed with its process (the coordinator shut down): a message continues it.
    ended('a4', 'killed')
    expect(store.list(project.id).map(t => [t.id, t.state, t.stop_reason, t.error])).toEqual([
      ['a1', 'stopped', 'user', null],
      ['a2', 'stopped', 'failed', 'boom'],
      ['a3', 'stopped', 'user', null],
      ['a4', 'stopped', 'exited', null],
    ])
  })

  it('keeps the restart reason when the server stops its coordinators', () => {
    const { store, project, child, started } = setup()
    started('a1')
    store.stopLive('restart')
    child({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'killed' })
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'stopped', stop_reason: 'restart' })
  })

  it('adds up the time of a task across a restart and a resumed run', () => {
    const { store, project, child, client, started, tick } = setup()
    started('a1')
    tick(27_000)
    store.stopLive('restart')
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'stopped', duration_ms: 27_000 })
    client({ type: 'control_request', request_id: 'm1', request: { subtype: 'send_task_message', task_id: 'a1', text: 'go on' } })
    child({ type: 'control_response', response: { subtype: 'success', request_id: 'm1', response: { delivery: 'resumed' } } })
    tick(400)
    child({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'ok', usage: { total_tokens: 10, duration_ms: 400 } })
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'review', duration_ms: 27_400 })
  })

  it('records a message to a task and resumes an ended one with the model it asked for', () => {
    const { store, project, child, client, started, tick } = setup()
    started('a1')
    child({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'ok' })
    store.review(project.id, 'a1')
    client({ type: 'control_request', request_id: 'm1', request: { subtype: 'send_task_message', task_id: 'a1', text: 'more', model: 'sonnet' } })
    tick(1000)
    child({ type: 'control_response', response: { subtype: 'success', request_id: 'm1', response: { delivery: 'resumed' } } })
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'running', model: 'sonnet', started_at: 2000, finished_at: null })
    // It finishes again and waits for review again.
    child({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'ok again' })
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'review', reviewed_at: null })
    expect(store.events('a1').map(e => e.kind)).toEqual(['started', 'finished', 'reviewed', 'message', 'finished'])

    // A refused message changes nothing.
    client({ type: 'control_request', request_id: 'm2', request: { subtype: 'send_task_message', task_id: 'a1', text: 'x', model: 'opus' } })
    child({ type: 'control_response', response: { subtype: 'error', request_id: 'm2', error: 'no' } })
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'review', model: 'sonnet' })
    expect(store.queuedMessages('a1')).toEqual([])
  })

  it('records how long a task ran when it stops without a usage report', () => {
    const { store, project, child, started, tick } = setup()
    started('a1')
    started('a2')
    tick(5000)
    child({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'killed' })
    store.stopLive('restart')
    expect(store.get(project.id, 'a1')).toMatchObject({ state: 'stopped', duration_ms: 5000 })
    expect(store.get(project.id, 'a2')).toMatchObject({ state: 'stopped', duration_ms: 5000 })
  })

  it('keeps the text of a message queued to a running task', () => {
    const { store, child, client, started, tick } = setup()
    started('a1')
    tick(500)
    client({ type: 'control_request', request_id: 'm1', request: { subtype: 'send_task_message', task_id: 'a1', text: 'also this' } })
    child({ type: 'control_response', response: { subtype: 'success', request_id: 'm1', response: { delivery: 'queued' } } })
    expect(store.queuedMessages('a1')).toEqual([{ id: expect.any(Number), ts: 1500, text: 'also this' }])
  })

  it('stops live tasks when their process goes away', () => {
    const { db, store, project, child, started } = setup()
    started('a1')
    started('a2')
    child({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, agent_id: 'a2' } })
    started('a3')
    child({ type: 'system', subtype: 'task_notification', task_id: 'a3', status: 'completed' })
    store.stopLive('exited', project.id)
    expect(store.list(project.id).map(t => [t.id, t.state, t.stop_reason, t.approval_id])).toEqual([
      ['a1', 'stopped', 'exited', null],
      ['a2', 'stopped', 'exited', null],
      ['a3', 'review', null, null],
    ])
    // A new server: what was still running is stopped by the restart.
    started('a4')
    new TaskStore(db).stopLive('restart')
    expect(store.get(project.id, 'a4')).toMatchObject({ state: 'stopped', stop_reason: 'restart' })
  })
})

describe('transcriptTokens', () => {
  it('counts the latest call\'s input, cache and output tokens', () => {
    expect(transcriptTokens([])).toBe(0)
    expect(
      transcriptTokens([
        { type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 5 } } },
        { type: 'user', message: {} },
        { type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 7 } } },
        { type: 'user', message: {} },
      ]),
    ).toBe(1117)
  })
})
