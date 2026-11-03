import { describe, expect, it } from 'bun:test'
import type { ProjectTask } from './api'
import {
  agentInputs,
  canMessage,
  messageTarget,
  notesByItem,
  taskElapsed,
  taskMeta,
  taskModel,
  taskNoteText,
  withApprovals,
  workerItems,
} from './projects'
import { type Approval, initialState, reduce } from './protocol'

const sys = (subtype: string, rest: Record<string, unknown>) => ({ type: 'system', subtype, session_id: 's', uuid: 'u', ...rest })

const assistant = (id: string, content: unknown[]) => ({
  type: 'assistant',
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content },
})

const row = (patch: Partial<ProjectTask>): ProjectTask => ({
  id: 'a',
  session_id: 's',
  agent_id: 'a',
  tool_use_id: null,
  title: 'Alpha',
  brief: 'Do alpha',
  subagent_type: 'worker',
  model: null,
  effort: null,
  worktree: null,
  state: 'running',
  stop_reason: null,
  error: null,
  summary: null,
  tokens: 6800,
  tool_uses: 2,
  duration_ms: 41_000,
  last_tool: 'WebFetch',
  approval_id: null,
  created_at: 0,
  started_at: 1_000,
  finished_at: null,
  reviewed_at: null,
  ...patch,
})

describe('project tasks', () => {
  it('notes each task that ends after the item last shown, and reads the Agent call input', () => {
    let state = reduce(
      initialState,
      assistant('m1', [
        { type: 'text', text: 'Two tasks.' },
        { type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Alpha', prompt: 'Do alpha', model: 'haiku' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Agent', input: { description: 'Beta', prompt: 'Do beta' } },
      ]),
    )
    for (const [id, tool, description] of [['a', 'toolu_a', 'Alpha'], ['b', 'toolu_b', 'Beta']]) {
      state = reduce(state, sys('task_started', { task_id: id, tool_use_id: tool, description, task_type: 'local_agent', spawn_depth: 1 }))
    }
    state = reduce(state, sys('task_notification', { task_id: 'a', status: 'completed', summary: 'done a', usage: { total_tokens: 8100, duration_ms: 95_000 } }))
    // Replayed on reattach: no second note.
    state = reduce(state, sys('task_notification', { task_id: 'a', status: 'completed', summary: 'done a' }))
    state = reduce(state, assistant('m2', [{ type: 'text', text: 'Alpha is done.' }]))
    state = reduce(state, sys('task_notification', { task_id: 'b', status: 'killed' }))

    expect(state.taskNotes).toEqual([
      { taskId: 'a', status: 'completed', afterId: 'm1', n: 1 },
      { taskId: 'b', status: 'killed', afterId: 'm2', n: 1 },
    ])
    expect(taskNoteText(state.taskNotes[0]!, state.tasks.a)).toEqual({ key: 'taskFinishedNote', vars: { title: 'Alpha', time: '1m35s' } })
    expect(taskNoteText(state.taskNotes[1]!, state.tasks.b)).toEqual({ key: 'taskStoppedNote', vars: { title: 'Beta' } })
    expect(taskNoteText({ taskId: 'x', status: 'failed', n: 1 }, undefined).key).toBe('taskFailedNote')
    expect(agentInputs(state.items).get('toolu_a')).toEqual({ description: 'Alpha', prompt: 'Do alpha', model: 'haiku' })
    const byItem = notesByItem(state.taskNotes, state.items)
    expect(byItem.get('m1')?.map(n => n.taskId)).toEqual(['a'])
    expect(notesByItem([{ taskId: 'z', status: 'completed', afterId: 'gone', n: 1 }], state.items).get('')).toHaveLength(1)
  })

  it('finds whom a SendMessage call addressed, by agent id or by the name its Agent call gave it', () => {
    const state = reduce(
      initialState,
      assistant('m1', [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Alpha', prompt: 'p', name: 'alpha' } }]),
    )
    const inputs = agentInputs(state.items)
    expect(messageTarget(JSON.stringify({ to: 'alpha', message: 'hi' }), inputs)).toEqual({ to: 'alpha', toolUseId: 'toolu_a' })
    expect(messageTarget(JSON.stringify({ to: 'a5f4', message: 'hi' }), inputs)).toEqual({ to: 'a5f4' })
    expect(messageTarget('{"to": "al', inputs)).toBeUndefined()
    expect(messageTarget(JSON.stringify({ message: 'hi' }), inputs)).toBeUndefined()
  })

  it('notes a resumed task each time it ends, and after a reload where the coordinator read each ending', () => {
    const notification = (uuid: string, status: string, ms: number) => ({
      type: 'user',
      isReplay: true,
      uuid,
      message: {
        role: 'user',
        content: `<task-notification>\n<task-id>a</task-id>\n<status>${status}</status>\n<summary>x</summary>\n<usage><duration_ms>${ms}</duration_ms></usage>\n</task-notification>`,
      },
    })
    const started = sys('task_started', { task_id: 'a', description: 'Alpha', task_type: 'local_agent', spawn_depth: 1, uuid: 's1' })
    const failed = sys('task_notification', { task_id: 'a', status: 'failed', uuid: 'n1' })
    const resumed = sys('task_started', { task_id: 'a', description: 'Alpha', task_type: 'local_agent', spawn_depth: 1, uuid: 's2' })
    const done = sys('task_notification', { task_id: 'a', status: 'completed', uuid: 'n2' })

    // Live: both endings, each once, though the first is seen twice.
    let live = reduce(initialState, assistant('m1', [{ type: 'text', text: 'Go.' }]))
    for (const line of [started, failed, failed, resumed]) live = reduce(live, line)
    live = reduce(live, assistant('m2', [{ type: 'text', text: 'Retrying.' }]))
    live = reduce(live, done)
    expect(live.taskNotes.map(n => [n.status, n.afterId, n.n])).toEqual([
      ['failed', 'm1', 1],
      ['completed', 'm2', 2],
    ])

    // Reload: the transcript places both, the replayed task lines add nothing.
    let loaded = reduce(initialState, assistant('m1', [{ type: 'text', text: 'Go.' }]))
    loaded = reduce(loaded, notification('u1', 'failed', 10))
    loaded = reduce(loaded, assistant('m2', [{ type: 'text', text: 'Retrying.' }]))
    loaded = reduce(loaded, notification('u2', 'completed', 95_000))
    loaded = reduce(loaded, assistant('m3', [{ type: 'text', text: 'Done.' }]))
    for (const line of [started, failed, resumed, done]) loaded = reduce(loaded, line)
    expect(loaded.items.map(i => i.id)).toEqual(['m1', 'm2', 'm3'])
    expect(loaded.taskNotes.map(n => [n.status, n.afterId, n.n])).toEqual([
      ['failed', 'm1', 1],
      ['completed', 'm2', 2],
    ])
    expect(taskNoteText(loaded.taskNotes[1]!, undefined).vars.time).toBe('1m35s')
  })

  it('notes no ending while an agent only waits on its own background work', () => {
    const waitingSummary = 'Agent "Alpha" is waiting on its own background work'
    let live = reduce(initialState, assistant('m1', [{ type: 'text', text: 'Go.' }]))
    live = reduce(live, sys('task_started', { task_id: 'a', description: 'Alpha', task_type: 'local_agent', spawn_depth: 1, uuid: 's1' }))
    live = reduce(live, sys('task_notification', { task_id: 'a', status: 'completed', waiting: true, summary: waitingSummary, uuid: 'n1' }))
    expect(live.tasks.a?.status).toBe('running')
    live = reduce(live, sys('task_notification', { task_id: 'a', status: 'completed', summary: 'done', uuid: 'n2' }))
    expect(live.taskNotes.map(n => [n.status, n.n])).toEqual([['completed', 1]])

    const notification = (uuid: string, summary: string) => ({
      type: 'user',
      isReplay: true,
      uuid,
      message: { role: 'user', content: `<task-notification>\n<task-id>a</task-id>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>` },
    })
    let loaded = reduce(initialState, assistant('m1', [{ type: 'text', text: 'Go.' }]))
    loaded = reduce(loaded, notification('u1', waitingSummary))
    loaded = reduce(loaded, assistant('m2', [{ type: 'text', text: 'Waiting.' }]))
    loaded = reduce(loaded, notification('u2', 'Agent "Alpha" finished'))
    expect(loaded.taskNotes.map(n => [n.afterId, n.n])).toEqual([['m2', 1]])
  })

  it('formats a card meta line, with the running clock and the tool only while running', () => {
    const task = row({})
    expect(taskMeta(task, 'Opus 5.5', 30_000)).toBe('Opus 5.5 · 41s · 6.8k tok · WebFetch')
    // No progress yet: the clock since the run started.
    expect(taskElapsed(row({ duration_ms: 0 }), 96_000)).toBe(95_000)
    expect(taskMeta(row({ duration_ms: 0, tokens: 0 }), undefined, 96_000)).toBe('1m35s · WebFetch')
    expect(taskMeta(row({ state: 'review' }), undefined, 999_000)).toBe('41s · 6.8k tok')
  })

  it('blocks a task whose worker asks here, picks its model and keeps a user-stopped task stopped', () => {
    const approval: Approval = { requestId: 'r', toolName: 'Bash', input: {}, suggestions: [], agentId: 'a' }
    expect(withApprovals([row({}), row({ id: 'b' })], [approval]).map(r => r.state)).toEqual(['blocked', 'running'])
    expect(taskModel(row({ model: 'sonnet' }), { model: 'haiku' }, 'opus', 'claude-x')).toBe('sonnet')
    expect(taskModel(row({}), { model: 'haiku' }, 'opus', 'claude-x')).toBe('haiku')
    expect(taskModel(row({}), undefined, 'opus', 'claude-x')).toBe('opus')
    expect(taskModel(row({}), undefined, null, 'claude-x')).toBe('claude-x')
    expect(canMessage(row({ state: 'stopped', stop_reason: 'user' }))).toBe(false)
    expect(canMessage(row({ state: 'stopped', stop_reason: 'restart' }))).toBe(true)
    expect(canMessage(row({ state: 'done' }))).toBe(true)
  })

  it('drops the worker\'s first prompt, which the task shows as its brief', () => {
    let state = reduce(initialState, { type: 'user', isReplay: true, uuid: 'u1', message: { role: 'user', content: 'Do alpha' } })
    state = reduce(state, assistant('m1', [{ type: 'text', text: 'On it.' }]))
    state = reduce(state, { type: 'user', isReplay: true, uuid: 'u2', message: { role: 'user', content: 'and more' } })
    expect(workerItems(state.items, 'Do alpha').map(i => i.kind)).toEqual(['assistant', 'user'])
    expect(workerItems(state.items, 'Other').map(i => i.kind)).toEqual(['user', 'assistant', 'user'])
  })
})
