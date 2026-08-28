import { describe, expect, test } from 'bun:test'
import {
  createRemoteDisplayTool,
  findRemoteDisplayTool,
} from './remoteDisplayTools.js'

describe('remote display tools', () => {
  test.each([
    ['Agent', { description: 'inspect', prompt: 'inspect' }],
    ['Bash', { command: 'pwd' }],
    ['ClearGoal', {}],
    ['Edit', { file_path: '/tmp/a', old_string: 'a', new_string: 'b' }],
    ['Read', { file_path: '/tmp/a' }],
    ['SendMessage', { to: 'reviewer', message: 'done', summary: 'Report done' }],
    ['SetGoal', { goal: 'finish validation' }],
    ['TaskCreate', { subject: 'Test', description: 'Test task' }],
    ['TaskGet', { taskId: '1' }],
    ['TaskList', {}],
    ['TaskOutput', { task_id: 'task-1' }],
    ['TaskStop', { task_id: 'task-1' }],
    ['TaskUpdate', { taskId: '1', status: 'in_progress' }],
    ['TeamCreate', { team_name: 'reviewers' }],
    ['TeamDelete', {}],
    ['Terminal', { action: 'list-panes' }],
    ['WorkflowTool', { action: 'list' }],
    ['Write', { file_path: '/tmp/a', content: 'value' }],
  ])('uses the %s renderer without enabling local execution', (name, input) => {
    const tool = findRemoteDisplayTool([], name)

    expect(tool.name).toBe(name)
    expect(tool.inputSchema.safeParse(input).success).toBe(true)
    expect(tool.isEnabled()).toBe(false)
  })

  test('creates a permissive non-executable fallback for unknown tools', async () => {
    const tool = createRemoteDisplayTool('mcp__remote__unknown')

    expect(tool.inputSchema.safeParse({ query: 'value' }).success).toBe(true)
    expect(tool.isEnabled()).toBe(false)
    await expect(
      tool.call(
        { query: 'value' },
        {} as never,
        {} as never,
        {} as never,
      ),
    ).rejects.toThrow('cannot be executed locally')
  })
})
