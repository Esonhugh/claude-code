import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as state from '../bootstrap/state.js'
import * as costs from '../cost-tracker.js'
import { asSessionId } from '../types/ids.js'
import { saveCurrentProjectConfig } from './config.js'
import { createCompactBoundaryMessage, createUserMessage } from './messages.js'
import { ModelUsageSchema } from '../entrypoints/sdk/coreSchemas.js'
import * as storage from './sessionStorage.js'
import type { SessionCostStateEntry } from '../types/logs.js'

let root: string
let restoreClock: () => void
let priorConfig: string | undefined
let priorPersistence: string | undefined
const now = 1791289000000
function snapshot(sessionId = state.getSessionId()): SessionCostStateEntry {
  return {
    type: 'cost-state', sessionId: sessionId as SessionCostStateEntry['sessionId'],
    totalCostUSD: 1.25, totalAPIDuration: 300, totalAPIDurationWithoutRetries: 200,
    totalToolDuration: 100, totalLinesAdded: 3, totalLinesRemoved: 2,
    totalDuration: 1234, startTime: now - 5000, hasUnknownModelCost: true,
    modelUsage: { 'claude-sonnet-4-6': {
      inputTokens: 20, outputTokens: 10, thinkingTokens: 6, cacheReadInputTokens: 4,
      cacheCreationInputTokens: 5, webSearchRequests: 1, costUSD: 1.25,
    } },
  }
}
async function transcript(entries: unknown[]) {
  await storage.recordTranscript([createUserMessage({ content: 'cost ledger source' })])
  await storage.flushSessionStorage()
  const path = storage.getTranscriptPath()
  await writeFile(path, await readFile(path, 'utf8') + entries.map(e => JSON.stringify(e) + '\n').join(''))
  return path
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'session-cost-state-'))
  priorConfig = process.env.CLAUDE_CONFIG_DIR
  priorPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  state.resetStateForTests()
  state.setOriginalCwd(root)
  storage.resetProjectForTesting()
  const clock = spyOn(Date, 'now').mockReturnValue(now)
  restoreClock = () => clock.mockRestore()
})
afterEach(async () => {
  await storage.flushSessionStorage()
  restoreClock()
  storage.resetProjectForTesting()
  state.resetStateForTests()
  if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = priorConfig
  if (priorPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = priorPersistence
  await rm(root, { recursive: true, force: true })
})

test('full last-valid snapshot follows the selected leaf through every loader', async () => {
  const first = snapshot(), last = { ...first, totalCostUSD: 2.5, modelUsage: {} }
  const foreign = { ...last, sessionId: randomUUID(), totalCostUSD: 9 }
  const path = await transcript([first, last, { ...last, totalCostUSD: -1 }, foreign])
  const parsed = await storage.loadTranscriptFile(path)
  expect(parsed.costStates?.get(state.getSessionId() as UUID)).toEqual(last)
  expect((await storage.loadTranscriptFromFile(path)).costState).toEqual(last)
  expect((await storage.getLastSessionLog(state.getSessionId() as UUID))?.costState).toEqual(last)
  const lite = { ...(await storage.loadTranscriptFromFile(path)), isLite: true }
  expect((await storage.loadFullLog(lite)).costState).toEqual(last)
  expect((await storage.loadAllLogsFromSessionFile(path))[0]?.costState).toEqual(last)
  const { loadMessagesFromJsonlPath, loadConversationForResume } = await import('./conversationRecovery.js')
  expect((await loadMessagesFromJsonlPath(path)).costState).toEqual(last)
  expect((await loadConversationForResume(state.getSessionId(), undefined))?.costState).toEqual(last)
})

test('restores all fields from JSONL instead of the most recent project cache', async () => {
  const saved = snapshot()
  const path = await transcript([saved])
  saveCurrentProjectConfig(project => ({ ...project, lastSessionId: randomUUID(), lastCost: 99 }))
  const log = await storage.loadTranscriptFromFile(path)
  expect(costs.restoreSessionCosts(log)).toBe(true)
  expect(state.getTotalCostUSD()).toBe(1.25)
  expect(state.getTotalAPIDuration()).toBe(300)
  expect(state.getTotalAPIDurationWithoutRetries()).toBe(200)
  expect(state.getTotalToolDuration()).toBe(100)
  expect(state.getTotalLinesAdded()).toBe(3)
  expect(state.getTotalLinesRemoved()).toBe(2)
  expect(state.getTotalDuration()).toBe(1234)
  expect(state.getSessionStartTime()).toBe(saved.startTime)
  expect(state.hasUnknownModelCost()).toBe(true)
  expect(state.getModelUsage()['claude-sonnet-4-6']).toMatchObject(saved.modelUsage['claude-sonnet-4-6']!)
  expect(state.getModelUsage()['claude-sonnet-4-6']?.contextWindow).toBeGreaterThan(0)
  expect(state.getModelUsage()['claude-sonnet-4-6']?.maxOutputTokens).toBeGreaterThan(0)
  expect(ModelUsageSchema().parse(state.getModelUsage()['claude-sonnet-4-6']).thinkingTokens).toBe(6)
  expect(state.getModelUsage()['claude-sonnet-4-6']).not.toHaveProperty('input_tokens')
})

test('session transition and final restamp persist the current full ledger', async () => {
  const path = await transcript([]), saved = snapshot()
  state.setCostStateForRestore({ ...saved, lastDuration: saved.totalDuration, modelUsage: Object.fromEntries(Object.entries(saved.modelUsage).map(([model, usage]) => [model, {
    ...usage, contextWindow: 200000, maxOutputTokens: 64000,
  }])) })
  state.setHasUnknownModelCost()
  costs.saveCurrentSessionCosts()
  await storage.flushSessionStorage()
  const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  expect(rows.findLast(e => e.type === 'cost-state')).toEqual(saved)
  storage.reAppendSessionMetadata()
  const final = await storage.loadTranscriptFromFile(path)
  expect((final).costState).toEqual(saved)
})

test('a transition snapshot follows buffered conversation writes in transcript order', async () => {
  const path = await transcript([])
  const message = createUserMessage({ content: 'pending final message' })
  await storage.recordTranscript([message])
  const saved = snapshot()
  state.setCostStateForRestore({ ...saved, lastDuration: saved.totalDuration, modelUsage: undefined })
  costs.saveCurrentSessionCosts()
  await storage.flushSessionStorage()
  const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
  expect(rows.at(-2)?.uuid).toBe(message.uuid)
  expect(rows.at(-1)?.type).toBe('cost-state')
  expect(rows.at(-1)?.totalCostUSD).toBe(saved.totalCostUSD)
})

test('a foreign snapshot cannot replace this session, but an explicit fork can inherit its source', () => {
  const source = snapshot()
  state.switchSession(asSessionId(randomUUID()), null)
  expect(costs.restoreSessionCosts({ sessionId: state.getSessionId(), costState: source })).toBe(false)
  expect(state.getTotalCostUSD()).toBe(0)
  expect(costs.restoreSessionCosts({ sessionId: source.sessionId, costState: source }, { forkSession: true })).toBe(true)
  expect(state.getTotalCostUSD()).toBe(source.totalCostUSD)
  expect(state.getSessionId()).not.toBe(source.sessionId)
})

test('legacy absence does not restore the project cache and absent unknown-cost flag clears stale state', () => {
  saveCurrentProjectConfig(project => ({ ...project, lastSessionId: state.getSessionId(), lastCost: 99 }))
  expect(costs.restoreSessionCosts({ sessionId: state.getSessionId() })).toBe(false)
  expect(state.getTotalCostUSD()).toBe(0)
  state.setHasUnknownModelCost()
  expect(costs.restoreSessionCosts({ sessionId: state.getSessionId(), costState: { ...snapshot(), hasUnknownModelCost: undefined } })).toBe(true)
  expect(state.hasUnknownModelCost()).toBe(false)
})

test('disabled persistence and a stale file pointer cannot append costs to another session', async () => {
  const path = await transcript([]), before = await readFile(path, 'utf8')
  state.setSessionPersistenceDisabled(true)
  costs.saveCurrentSessionCosts()
  storage.reAppendSessionMetadata()
  expect(await readFile(path, 'utf8')).toBe(before)
  state.setSessionPersistenceDisabled(false)
  state.switchSession(asSessionId(randomUUID()), null)
  costs.saveCurrentSessionCosts()
  expect(await readFile(path, 'utf8')).toBe(before)
})

test('activity clock rollback cannot produce a negative persisted duration', () => {
  state.setCostStateForRestore({ ...snapshot(), lastDuration: 0, modelUsage: undefined })
  const rollback = spyOn(Date, 'now').mockReturnValue(now - 1000)
  try { expect(state.getTotalDuration()).toBe(0) }
  finally { rollback.mockRestore() }
})

test('full cost fields survive the production precompact scan and an invalid later snapshot', async () => {
  const saved = snapshot()
  const boundary = {
    ...createCompactBoundaryMessage('manual', 10),
    sessionId: saved.sessionId, cwd: root, isSidechain: false, parentUuid: null, version: '2.1.291',
  }
  const user = {
    ...createUserMessage({ content: 'after compact' }),
    sessionId: saved.sessionId, cwd: root, isSidechain: false, parentUuid: boundary.uuid, version: '2.1.291',
  }
  const path = join(root, 'precompact.jsonl')
  await writeFile(path, [
    saved, { type: 'progress', padding: 'x'.repeat(6 * 1024 * 1024) },
    boundary, { ...saved, totalDuration: 1e16 }, user,
  ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
  const log = await storage.loadTranscriptFromFile(path)
  expect(log.costState).toEqual(saved)
  expect(costs.restoreSessionCosts(log)).toBe(true)
  expect(state.getTotalCostUSD()).toBe(saved.totalCostUSD)
  expect(state.getModelUsage()['claude-sonnet-4-6']?.thinkingTokens).toBe(6)
})

test('a validated cost snapshot retains its numeric start time without rounding', () => {
  const saved = { ...snapshot(), startTime: now - 5000.5 }
  expect(costs.restoreSessionCosts({ sessionId: state.getSessionId(), costState: saved })).toBe(true)
  expect(state.getSessionStartTime()).toBe(saved.startTime)
})
