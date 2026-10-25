import { afterEach, expect, test } from 'bun:test'
import { restoreWorktreeSession } from '../../utils/worktree.js'
import { EnterWorktreeTool } from './EnterWorktreeTool.js'

afterEach(() => restoreWorktreeSession(null))

test('accepts name or path but not both', () => {
  const schema = EnterWorktreeTool.inputSchema
  expect(schema.safeParse({ name: 'feature' }).success).toBe(true)
  expect(schema.safeParse({ path: '../existing' }).success).toBe(true)
  expect(schema.safeParse({ name: 'feature', path: '../existing' }).success).toBe(false)
})

test('inside a worktree session only path switches are allowed', async () => {
  restoreWorktreeSession({
    originalCwd: '/repo',
    worktreePath: '/repo/.claude/worktrees/a',
    worktreeName: 'a',
    sessionId: 's',
  })
  const context = {} as Parameters<typeof EnterWorktreeTool.validateInput>[1]
  expect(await EnterWorktreeTool.validateInput!({ name: 'b' }, context)).toMatchObject({
    result: false,
    errorCode: 2,
  })
  expect(await EnterWorktreeTool.validateInput!({ path: '/repo/.claude/worktrees/b' }, context)).toEqual({ result: true })
  expect(EnterWorktreeTool.userFacingName({ path: '/x' })).toBe('Entering worktree')
  expect(EnterWorktreeTool.userFacingName({})).toBe('Creating worktree')
})
