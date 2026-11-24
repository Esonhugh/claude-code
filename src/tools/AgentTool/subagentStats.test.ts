import { beforeEach, expect, test } from 'bun:test'

import { regenerateSessionId, switchSession } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import { subagentStats } from './subagentStats.js'

beforeEach(() => {
  regenerateSessionId()
})

const spawn = (over: Partial<Parameters<ReturnType<typeof subagentStats>['recordSpawn']>[0]> = {}) =>
  subagentStats().recordSpawn({
    agentType: 'general-purpose',
    runInBackground: undefined,
    runsInBackground: false,
    depth: 1,
    ...over,
  })

test('a new session reports all zeros', () => {
  expect(subagentStats().snapshot()).toEqual({
    spawned: 0,
    requested: { background: 0, foreground: 0, unset: 0 },
    started_in_background: 0,
    by_type: {},
    max_depth: 0,
    spawned_by_subagents: 0,
    completed: 0,
    failed: 0,
    killed: { parent: 0, user: 0, system: 0 },
    refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
  })
})

test('spawns count by requested background, started background, type and depth', () => {
  spawn({ runInBackground: true, runsInBackground: true })
  spawn({ runInBackground: false, agentType: 'Explore' })
  spawn({ runsInBackground: true, depth: 2, agentType: 'Explore' })
  subagentStats().recordRefused('concurrency_limit')
  subagentStats().recordRefused('depth_limit')

  const stats = subagentStats().snapshot()
  expect(stats.spawned).toBe(3)
  expect(stats.requested).toEqual({ background: 1, foreground: 1, unset: 1 })
  expect(stats.started_in_background).toBe(2)
  expect(stats.by_type).toEqual({ 'general-purpose': 1, Explore: 2 })
  expect(stats.max_depth).toBe(2)
  expect(stats.spawned_by_subagents).toBe(1)
  expect(stats.refused).toEqual({ depth_limit: 1, concurrency_limit: 1, budget: 0 })
})

test('the first outcome of a spawn is the one counted', () => {
  const a = spawn()
  a.completed()
  a.failed()
  a.killed('parent')
  const b = spawn()
  b.killed('system')
  b.completed()
  spawn().failed()

  const stats = subagentStats().snapshot()
  expect(stats.completed).toBe(1)
  expect(stats.failed).toBe(1)
  expect(stats.killed).toEqual({ parent: 0, user: 0, system: 1 })
})

test('a result cancelled just as the subagent finished counts as a user kill', () => {
  const done = spawn()
  done.completed()
  done.cancelledAfterCompletion()
  spawn().cancelledAfterCompletion()

  const stats = subagentStats().snapshot()
  expect(stats.completed).toBe(0)
  expect(stats.killed.user).toBe(2)
})

test('a snapshot is a copy', () => {
  spawn()
  const before = subagentStats().snapshot()
  spawn({ runInBackground: true })
  subagentStats().recordRefused('budget')
  expect(before.spawned).toBe(1)
  expect(before.requested.background).toBe(0)
  expect(before.refused.budget).toBe(0)
  expect(before.by_type).toEqual({ 'general-purpose': 1 })
})

test('clear and resume start from zero; a subagent outliving the change still reports', () => {
  const outlives = spawn()
  regenerateSessionId()
  expect(subagentStats().snapshot().spawned).toBe(0)
  outlives.completed()
  expect(subagentStats().snapshot().completed).toBe(1)

  spawn()
  switchSession('00000000-0000-4000-8000-000000000001' as SessionId)
  expect(subagentStats().snapshot().spawned).toBe(0)
  expect(subagentStats().snapshot().completed).toBe(0)
})
