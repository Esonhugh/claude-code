import { describe, expect, it } from 'bun:test'
import type { AgentTask } from './agents'
import { agentInputs, notesByItem, projectTasks, taskMeta, taskNoteText, taskState } from './projects'
import { initialState, reduce } from './protocol'

const sys = (subtype: string, rest: Record<string, unknown>) => ({ type: 'system', subtype, session_id: 's', uuid: 'u', ...rest })

const assistant = (id: string, content: unknown[]) => ({
  type: 'assistant',
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content },
})

describe('project tasks', () => {
  it('folds two dispatched workers and notes each one that ends after the item last shown', () => {
    let state = reduce(
      initialState,
      assistant('m1', [
        { type: 'text', text: 'Two tasks.' },
        { type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'Alpha', prompt: 'Do alpha' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Agent', input: { description: 'Beta', prompt: 'Do beta' } },
      ]),
    )
    for (const [id, tool, description] of [['a', 'toolu_a', 'Alpha'], ['b', 'toolu_b', 'Beta']]) {
      state = reduce(state, sys('task_started', { task_id: id, tool_use_id: tool, description, task_type: 'local_agent', spawn_depth: 1 }))
    }
    // A nested agent is not a project task.
    state = reduce(state, sys('task_started', { task_id: 'n', description: 'Nested', task_type: 'local_agent', spawn_depth: 2 }))
    state = reduce(state, sys('task_progress', { task_id: 'a', last_tool_name: 'Read', summary: 'reading', usage: { total_tokens: 6800, duration_ms: 95_000 } }))
    state = reduce(state, sys('task_notification', { task_id: 'a', status: 'completed', summary: 'done a', usage: { total_tokens: 8100, duration_ms: 95_000 } }))
    // Replayed on reattach: no second note.
    state = reduce(state, sys('task_notification', { task_id: 'a', status: 'completed', summary: 'done a' }))
    state = reduce(state, assistant('m2', [{ type: 'text', text: 'Alpha is done.' }]))
    state = reduce(state, sys('task_notification', { task_id: 'b', status: 'killed' }))

    const tasks = projectTasks(state.tasks)
    expect(tasks.map(t => t.description)).toEqual(['Alpha', 'Beta'])
    expect(state.taskNotes).toEqual([
      { taskId: 'a', status: 'completed', afterId: 'm1' },
      { taskId: 'b', status: 'killed', afterId: 'm2' },
    ])
    const [a, b] = tasks as [AgentTask, AgentTask]
    expect(taskState(a, new Set())).toBe('review')
    expect(taskState(a, new Set(['a']))).toBe('done')
    expect(taskState(b, new Set())).toBe('stopped')
    expect(taskNoteText(state.taskNotes[0]!, a)).toEqual({ key: 'taskFinishedNote', vars: { title: 'Alpha', time: '1m35s' } })
    expect(taskNoteText(state.taskNotes[1]!, b)).toEqual({ key: 'taskStoppedNote', vars: { title: 'Beta' } })
    expect(taskNoteText({ taskId: 'x', status: 'failed' }, undefined).key).toBe('taskFailedNote')
    expect(agentInputs(state.items).get('toolu_b')).toEqual({ description: 'Beta', prompt: 'Do beta' })
    const byItem = notesByItem(state.taskNotes, state.items)
    expect(byItem.get('m1')?.map(n => n.taskId)).toEqual(['a'])
    expect(notesByItem([{ taskId: 'z', status: 'completed', afterId: 'gone' }], state.items).get('')).toHaveLength(1)
  })

  it('formats a card meta line, with the tool only while running', () => {
    const task: AgentTask = { id: 't', type: 'local_agent', description: 'x', status: 'running', depth: 0, seq: 0, tokens: 6800, durationMs: 41_000, lastTool: 'WebFetch' }
    expect(taskMeta(task, 'running', 'Opus 5.5')).toBe('Opus 5.5 · 41s · 6.8k tok · WebFetch')
    expect(taskMeta({ ...task, status: 'completed' }, 'review', undefined)).toBe('41s · 6.8k tok')
  })
})
