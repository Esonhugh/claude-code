import { afterEach, expect, test } from 'bun:test'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { PermissionDecision } from '../../types/permissions.js'
import { createInProcessCanUseTool } from './inProcessRunner.js'
import {
  registerLeaderHeadlessCanUseTool,
  registerLeaderToolUseConfirmQueue,
  unregisterLeaderToolUseConfirmQueue,
} from './leaderPermissionBridge.js'

const identity = { agentId: 'alice@t', agentName: 'alice', teamName: 't', color: 'blue' } as never
const ask: PermissionDecision = { behavior: 'ask', message: 'needs approval' }

afterEach(() => {
  unregisterLeaderToolUseConfirmQueue()
  registerLeaderHeadlessCanUseTool(null)
})

test('a headless leader answers a teammate ask with its own permission handler', async () => {
  const seen: unknown[] = []
  const leader: CanUseToolFn = async (tool, _input, _ctx, _msg, toolUseID, forced) => {
    seen.push([tool.name, toolUseID, forced])
    return { behavior: 'deny', message: 'no prompt in -p', decisionReason: { type: 'other', reason: 'x' } }
  }
  registerLeaderHeadlessCanUseTool(leader)
  const canUseTool = createInProcessCanUseTool(identity, new AbortController())
  const decision = await Promise.race([
    canUseTool({ name: 'Bash' } as never, {}, {} as never, {} as never, 'tu1', ask),
    new Promise(r => setTimeout(() => r('hung'), 1000)),
  ])
  expect(decision).toMatchObject({ behavior: 'deny' })
  expect(seen).toEqual([['Bash', 'tu1', ask]])
})

test('the REPL dialog queue still wins over the headless handler', async () => {
  let headlessCalled = false
  registerLeaderHeadlessCanUseTool(async () => {
    headlessCalled = true
    return ask
  })
  const queued: unknown[] = []
  registerLeaderToolUseConfirmQueue(update => {
    queued.push(...update([]))
  })
  const canUseTool = createInProcessCanUseTool(identity, new AbortController())
  void canUseTool(
    { name: 'Bash', description: async () => 'd' } as never,
    {},
    { getAppState: () => ({ toolPermissionContext: {} }), options: { tools: [] } } as never,
    {} as never,
    'tu2',
    ask,
  )
  await new Promise(r => setTimeout(r, 50))
  expect(headlessCalled).toBe(false)
  expect(queued.length).toBe(1)
})
