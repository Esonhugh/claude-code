import { describe, expect, it } from 'bun:test'
import type { ProjectTask } from './api'
import {
  agentInputs,
  canMessage,
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
      { taskId: 'a', status: 'completed', afterId: 'm1' },
      { taskId: 'b', status: 'killed', afterId: 'm2' },
    ])
    expect(taskNoteText(state.taskNotes[0]!, state.tasks.a)).toEqual({ key: 'taskFinishedNote', vars: { title: 'Alpha', time: '1m35s' } })
    expect(taskNoteText(state.taskNotes[1]!, state.tasks.b)).toEqual({ key: 'taskStoppedNote', vars: { title: 'Beta' } })
    expect(taskNoteText({ taskId: 'x', status: 'failed' }, undefined).key).toBe('taskFailedNote')
    expect(agentInputs(state.items).get('toolu_a')).toEqual({ description: 'Alpha', prompt: 'Do alpha', model: 'haiku' })
    const byItem = notesByItem(state.taskNotes, state.items)
    expect(byItem.get('m1')?.map(n => n.taskId)).toEqual(['a'])
    expect(notesByItem([{ taskId: 'z', status: 'completed', afterId: 'gone' }], state.items).get('')).toHaveLength(1)
  })

  it('formats a card meta line, with the running clock and the tool only while running', () => {
    const task = row({})
    expect(taskMeta(task, 'Opus 5.5', 30_000)).toBe('Opus 5.5 · 41s · 6.8k tok · WebFetch')
    // No progress yet: the clock since the run started.
    expect(taskElapsed(row({ duration_ms: 0 }), 96_000)).toBe(95_000)
    expect(taskMeta(row({ duration_ms: 0, tokens: 0 }), undefined, 96_000)).toBe('1m35s · 0.0k tok · WebFetch')
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
