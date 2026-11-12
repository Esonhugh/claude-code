import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
const configDir = await mkdtemp(join(tmpdir(), 'task-update-concurrent-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
})

const { createTask, getTask, getTaskListId } = await import('../../utils/tasks.js')
const { TaskUpdateTool } = await import('./TaskUpdateTool.js')

test('parallel TaskUpdate calls on one task keep every change', async () => {
  const taskListId = getTaskListId()
  const ids: string[] = []
  for (const subject of ['one', 'two', 'three']) {
    ids.push(await createTask(taskListId, { subject, description: subject, status: 'pending', blocks: [], blockedBy: [] }))
  }
  const [one, two, three] = ids as [string, string, string]
  const context = { setAppState: (update: (state: unknown) => unknown) => update({ expandedView: 'tasks' }) } as never
  // TaskUpdate is concurrency-safe, so one assistant message can run these together.
  const results = await Promise.all([
    TaskUpdateTool.call({ taskId: one, addBlockedBy: [two] }, context),
    TaskUpdateTool.call({ taskId: one, addBlockedBy: [three] }, context),
    TaskUpdateTool.call({ taskId: one, metadata: { x: 1 } }, context),
    TaskUpdateTool.call({ taskId: one, metadata: { y: 2 } }, context),
  ])
  expect(results.every(result => result.data.success)).toBe(true)
  const task = await getTask(taskListId, one)
  expect(task?.blockedBy.toSorted()).toEqual([two, three].toSorted())
  expect(task?.metadata).toEqual({ x: 1, y: 2 })
})
