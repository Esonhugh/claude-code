#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const configDir = await mkdtemp(join(tmpdir(), 'task-update-test-'))
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

try {
  const { createTask, getTask, getTaskListId } = await import('../../utils/tasks.js')
  const { TaskUpdateTool } = await import('./TaskUpdateTool.js')
  const taskListId = getTaskListId()
  const taskId = await createTask(taskListId, {
    subject: 'Source task',
    description: 'Source task description',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  })
  const context = {
    setAppState: (update: (state: any) => any) =>
      update({ expandedView: 'tasks' }),
  } as any

  const result = await TaskUpdateTool.call(
    { taskId, addBlocks: ['missing-task'] },
    context,
  )

  assert.equal(result.data.success, false)
  assert.match(result.data.error ?? '', /missing-task/)
  assert.deepEqual((await getTask(taskListId, taskId))?.blocks, [])

  const blockedByResult = await TaskUpdateTool.call(
    { taskId, addBlockedBy: ['missing-blocker'] },
    context,
  )

  assert.equal(blockedByResult.data.success, false)
  assert.match(blockedByResult.data.error ?? '', /missing-blocker/)
  assert.deepEqual((await getTask(taskListId, taskId))?.blockedBy, [])
} finally {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
}

console.log('TaskUpdateTool.test.ts passed')
