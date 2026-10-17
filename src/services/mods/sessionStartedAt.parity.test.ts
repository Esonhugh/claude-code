import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionId,
  getTotalDuration,
  getSessionStartedAt,
  resetStateForTests,
  setCostStateForRestore,
  switchSession,
} from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
} from '../../utils/messages.js'
import {
  getStoredSessionCosts,
  restoreCostStateForSession,
  saveCurrentSessionCosts,
} from '../../cost-tracker.js'
import { saveCurrentProjectConfig } from '../../utils/config.js'
import * as storage from '../../utils/sessionStorage.js'
import {
  captureModSessionUsage,
  validateModSessionUsage,
} from './sessionUsage.js'
const launch = 1791080000123
function costRow(sessionId: string, startTime: number) {
  return {
    type: 'cost-state',
    sessionId,
    startTime,
    totalCostUSD: 0,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalDuration: 1234,
    modelUsage: {},
  }
}
let now = launch,
  root: string,
  restoreClock: () => void
const cost = {
  totalCostUSD: 0,
  totalAPIDuration: 0,
  totalAPIDurationWithoutRetries: 0,
  totalToolDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  lastDuration: 1234,
  modelUsage: undefined,
}
function readUsage() {
  const state = getDefaultAppState()
  return captureModSessionUsage({
    messages: [],
    getAppState: () => state,
    options: {
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
        allowedAgentTypes: undefined,
      },
    },
  })({})
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-started-at-parity-'))
  now = launch
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  restoreClock = () => clock.mockRestore()
  resetStateForTests()
  storage.resetProjectForTesting()
})
afterEach(async () => {
  await storage.flushSessionStorage()
  storage.resetProjectForTesting()
  restoreClock()
  resetStateForTests()
  await rm(root, { recursive: true, force: true })
})
test('official usage requires the numeric start even without recorded launch metadata', async () => {
  now += 100000
  switchSession(asSessionId(randomUUID()))
  setCostStateForRestore(cost)
  expect(getSessionStartedAt()).toBeUndefined()
  const usage = await readUsage()
  expect(usage.startedAt).toBe(now - cost.lastDuration)
  expect(() =>
    validateModSessionUsage({
      context: usage.context,
      rateLimits: usage.rateLimits,
    }),
  ).toThrow()
})
test('official cost startTime restores the logical epoch independently of active duration', async () => {
  now += 100000
  switchSession(asSessionId(randomUUID()))
  const saved = { ...cost, startTime: launch }
  setCostStateForRestore(saved)
  expect((await readUsage()).startedAt).toBe(launch)
})
test('official JSONL cost-state startTime is restored only for the selected session', async () => {
  const id = randomUUID(),
    foreign = randomUUID()
  const path = join(root, 'official.jsonl')
  const user = {
    ...createUserMessage({ content: 'original' }),
    sessionId: id,
    cwd: root,
    isSidechain: false,
    parentUuid: null,
    version: '2.1.291',
  }
  await writeFile(
    path,
    [costRow(foreign, launch - 99999), costRow(id, launch), user]
      .map((v) => JSON.stringify(v))
      .join('\n') + '\n',
  )
  const log = await storage.loadTranscriptFromFile(path)
  expect(log.startedAt).toBe(launch)
  now += 100000
  switchSession(asSessionId(id))
  storage.restoreSessionMetadata(log)
  expect((await readUsage()).startedAt).toBe(launch)
})
test('official lastStartTime is read, restored and saved on the existing project cost path', async () => {
  now += 100000
  switchSession(asSessionId(randomUUID()))
  const id = getSessionId()
  saveCurrentProjectConfig((c) => ({
    ...c,
    lastSessionId: id,
    lastStartTime: launch,
    lastDuration: cost.lastDuration,
  }))
  expect(getStoredSessionCosts(id)).toHaveProperty('startTime', launch)
  restoreCostStateForSession(id)
  expect((await readUsage()).startedAt).toBe(launch)
  saveCurrentSessionCosts()
  expect(getStoredSessionCosts(id)).toHaveProperty('startTime', launch)
  expect(getStoredSessionCosts(randomUUID())).toBeUndefined()
})
test('native resume metadata cannot erase the same-session project cost start restored immediately before it', async () => {
  now += 100000
  switchSession(asSessionId(randomUUID()))
  const id = getSessionId()
  saveCurrentProjectConfig((c) => ({
    ...c,
    lastSessionId: id,
    lastStartTime: launch,
    lastDuration: cost.lastDuration,
  }))
  restoreCostStateForSession(id)
  storage.restoreSessionMetadata({ sessionId: id })
  expect((await readUsage()).startedAt).toBe(launch)
})
test('legacy metadata still falls back to the activity clock when project costs belong to another session', async () => {
  now += 100000
  switchSession(asSessionId(randomUUID()))
  const id = getSessionId()
  saveCurrentProjectConfig((c) => ({
    ...c,
    lastSessionId: randomUUID(),
    lastStartTime: launch,
    lastDuration: cost.lastDuration,
  }))
  restoreCostStateForSession(id)
  storage.restoreSessionMetadata({ sessionId: id })
  expect(getSessionStartedAt()).toBeUndefined()
  expect((await readUsage()).startedAt).toBe(launch)
})

test('official cost-state uses the last valid snapshot and refuses incomplete or unbounded rows', async () => {
  const id = randomUUID(),
    path = join(root, 'cost-state-validation.jsonl')
  const user = {
    ...createUserMessage({ content: 'original' }),
    sessionId: id,
    cwd: root,
    isSidechain: false,
    parentUuid: null,
    version: '2.1.291',
  }
  const invalid = [
    { type: 'cost-state', sessionId: id, startTime: launch - 99 },
    { ...costRow(id, launch - 99), totalCostUSD: 1e9 + 1 },
    { ...costRow(id, launch - 99), totalDuration: -1 },
    {
      ...costRow(id, launch - 99),
      modelUsage: { 'invalid\u0000model': { inputTokens: 0 } },
    },
  ]
  await writeFile(
    path,
    [costRow(id, launch - 100), costRow(id, launch), ...invalid, user]
      .map((v) => JSON.stringify(v))
      .join('\n') + '\n',
  )
  expect((await storage.loadTranscriptFromFile(path)).startedAt).toBe(launch)
  for (const row of invalid) {
    await writeFile(
      path,
      [row, user].map((v) => JSON.stringify(v)).join('\n') + '\n',
    )
    expect(
      (await storage.loadTranscriptFromFile(path)).startedAt,
    ).toBeUndefined()
  }
})

test('zero saved duration restarts the activity clock and future starts are bounded by it', async () => {
  now += 100000
  switchSession(asSessionId(randomUUID()))
  setCostStateForRestore({ ...cost, lastDuration: 0, startTime: now + 100000 })
  expect(getTotalDuration()).toBe(0)
  expect((await readUsage()).startedAt).toBe(now)
})

test('bounded model totals and precompact cost snapshots survive the production loader', async () => {
  const id = randomUUID(),
    path = join(root, 'precompact-cost.jsonl')
  const model = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
  }
  const boundary = {
    ...createCompactBoundaryMessage('manual', 10),
    sessionId: id,
    cwd: root,
    isSidechain: false,
    parentUuid: null,
    version: '2.1.291',
  }
  const user = {
    ...createUserMessage({ content: 'after compact' }),
    sessionId: id,
    cwd: root,
    isSidechain: false,
    parentUuid: boundary.uuid,
    version: '2.1.291',
  }
  const valid = { ...costRow(id, launch), modelUsage: { sonnet: model } }
  const invalid = {
    ...costRow(id, launch - 100),
    modelUsage: {
      a: { ...model, inputTokens: 1e15 },
      b: { ...model, inputTokens: 1 },
    },
  }
  await writeFile(
    path,
    [
      valid,
      { type: 'progress', padding: 'x'.repeat(6 * 1024 * 1024) },
      boundary,
      invalid,
      user,
    ]
      .map((v) => JSON.stringify(v))
      .join('\n') + '\n',
  )
  expect((await storage.loadTranscriptFromFile(path)).startedAt).toBe(launch)
  await writeFile(
    path,
    [invalid, user].map((v) => JSON.stringify(v)).join('\n') + '\n',
  )
  expect((await storage.loadTranscriptFromFile(path)).startedAt).toBeUndefined()
})

test('restored metadata cannot move the logical epoch beyond the activity clock', async () => {
  now += 100000
  switchSession(asSessionId(randomUUID()))
  setCostStateForRestore(cost)
  storage.restoreSessionMetadata({sessionId: getSessionId(), startedAt: now + 100000})
  expect((await readUsage()).startedAt).toBe(now - cost.lastDuration)
})
