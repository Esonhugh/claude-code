import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'task-list-'))
process.env.CLAUDE_CODE_TASK_LIST_ID = 'team-x'
const { createTask, updateTask } = await import('../utils/tasks.js')
const { buildTaskListResponse } = await import('./hostControlRequests.js')

// A teammate's TaskUpdate never reaches the lead's transcript; the host reads the shared list.
test('get_task_list returns the shared task list as teammates left it', async () => {
  const base = { description: '', blocks: [], blockedBy: [] }
  const one = await createTask('team-x', { ...base, subject: 'alice: octopuses', status: 'pending', activeForm: 'Sharing' })
  await createTask('team-x', { ...base, subject: 'bob: owls', status: 'pending' })
  await updateTask('team-x', one, { status: 'completed' })
  const { tasks } = await buildTaskListResponse()
  expect(tasks.sort((a, b) => Number(a.id) - Number(b.id)) as unknown[]).toEqual([
    { id: one, subject: 'alice: octopuses', status: 'completed', activeForm: 'Sharing' },
    { id: expect.any(String), subject: 'bob: owls', status: 'pending' },
  ])
})
