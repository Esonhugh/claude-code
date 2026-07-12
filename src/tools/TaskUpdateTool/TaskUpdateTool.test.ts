#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
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
  const tasksModule = await import('../../utils/tasks.js')
  const { createTask, getTask, getTaskListId } = tasksModule
  const originalBlockTask = tasksModule.blockTask
  mock.module('../../utils/tasks.js', () => ({
    ...tasksModule,
    blockTask: async (
      taskListId: string,
      fromTaskId: string,
      toTaskId: string,
    ) => {
      if (toTaskId === '3') return false
      return originalBlockTask(taskListId, fromTaskId, toTaskId)
    },
  }))
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

  const firstTargetId = await createTask(taskListId, {
    subject: 'First target',
    description: 'First target description',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  })
  const secondTargetId = await createTask(taskListId, {
    subject: 'Second target',
    description: 'Second target description',
    status: 'pending',
    blocks: [],
    blockedBy: [],
  })
  assert.equal(secondTargetId, '3')

  const partialResult = await TaskUpdateTool.call(
    {
      taskId,
      subject: 'Updated before dependency failure',
      addBlocks: [firstTargetId, secondTargetId],
    },
    context,
  )

  assert.equal(partialResult.data.success, false)
  assert.equal(partialResult.data.partial, true)
  assert.equal(partialResult.data.stage, 'addBlocks')
  assert.deepEqual(partialResult.data.committed, ['subject', 'blocks:2'])
  assert.deepEqual(partialResult.data.pending, ['blocks:3'])
  assert.equal(partialResult.data.retryable, true)

  const partialBlock = TaskUpdateTool.mapToolResultToToolResultBlockParam(
    partialResult.data,
    'tool-use-id',
  )
  assert.match(String(partialBlock.content), /Partial update at addBlocks/)
  assert.match(String(partialBlock.content), /committed: subject, blocks:2/)
  assert.match(String(partialBlock.content), /pending: blocks:3/)
} finally {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(configDir, { recursive: true, force: true })
}

console.log('TaskUpdateTool.test.ts passed')
