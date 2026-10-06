import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionId,
  getTotalDuration,
  regenerateSessionId,
  resetCostState,
  resetStateForTests,
  setCostStateForRestore,
  switchSession,
} from '../../bootstrap/state.js'
import { asSessionId } from '../../types/ids.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../../utils/messages.js'
import * as storage from '../../utils/sessionStorage.js'
import { captureModSessionUsage } from './sessionUsage.js'

const launch = 1791080000123
let now = launch
let root: string
let restoreClock: () => void
const zeroCost = {
  totalCostUSD: 0,
  totalAPIDuration: 0,
  totalAPIDurationWithoutRetries: 0,
  totalToolDuration: 0,
  totalLinesAdded: 0,
  totalLinesRemoved: 0,
  lastDuration: 1234,
  modelUsage: undefined,
}
function reader() {
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
  })
}
function epoch(value: unknown): number | undefined {
  return (value as { startedAt?: number }).startedAt
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-started-at-'))
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

test('first launch is independent of the resumed cost duration clock', async () => {
  expect(epoch(await reader()({}))).toBe(launch)
  now += 100000
  setCostStateForRestore(zeroCost)
  expect(getTotalDuration()).toBe(1234)
  expect(epoch(await reader()({}))).toBe(launch)
  resetCostState()
  expect(getTotalDuration()).toBe(0)
  expect(epoch(await reader()({}))).toBe(launch)
})

test('a captured usage keeps its epoch and clear starts a new one', async () => {
  const captured = reader()
  const oldId = getSessionId()
  now += 100000
  regenerateSessionId()
  expect(getSessionId()).not.toBe(oldId)
  expect(epoch(await captured({}))).toBe(launch)
  expect(epoch(await reader()({}))).toBe(now)
})

test('new transcript materialization durably records the known launch', async () => {
  const saved = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  try {
    now += 100000
    await storage.recordTranscript([
      createUserMessage({ content: 'first prompt' }),
    ])
    await storage.flushSessionStorage()
    const rows = (await readFile(storage.getTranscriptPath(), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows.filter((row) => row.type === 'session-started-at')).toEqual([
      {
        type: 'session-started-at',
        sessionId: getSessionId(),
        startedAt: launch,
      },
    ])
  } finally {
    if (saved === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = saved
  }
})

test('saved launch follows the actual session leaf and survives the resume loader', async () => {
  const sessionId = randomUUID() as UUID
  const foreign = randomUUID() as UUID
  const path = join(root, 'session.jsonl')
  const row = {
    ...createUserMessage({ content: 'saved' }),
    sessionId,
    cwd: root,
    isSidechain: false,
    parentUuid: null,
    version: 'test',
  }
  await writeFile(
    path,
    [
      { type: 'session-started-at', sessionId, startedAt: launch },
      { type: 'session-started-at', sessionId: foreign, startedAt: launch - 1 },
      row,
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )
  const log = await storage.loadTranscriptFromFile(path)
  expect(epoch(log)).toBe(launch)
  expect(log.sessionId).toBe(sessionId)
  now += 100000
  switchSession(asSessionId(sessionId))
  storage.restoreSessionMetadata({ ...log, sessionId })
  expect(epoch(await reader()({}))).toBe(launch)
})

test('an inherited source row cannot change the fork leaf identity or launch', async () => {
  const sourceId = randomUUID() as UUID
  const forkId = randomUUID() as UUID
  const source = {
    ...createUserMessage({ content: 'inherited' }),
    sessionId: sourceId,
    cwd: root,
    isSidechain: false,
    parentUuid: null,
    version: 'test',
  }
  const leaf = {
    ...createAssistantMessage({ content: 'fork reply' }),
    sessionId: forkId,
    cwd: root,
    isSidechain: false,
    parentUuid: source.uuid,
    version: 'test',
  }
  const path = join(root, 'fork.jsonl')
  await writeFile(
    path,
    [
      {
        type: 'session-started-at',
        sessionId: sourceId,
        startedAt: launch - 99999,
      },
      { type: 'session-started-at', sessionId: forkId, startedAt: launch },
      source,
      leaf,
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )
  const log = await storage.loadTranscriptFromFile(path)
  expect(storage.getSessionIdFromLog(log)).toBe(forkId)
  expect(epoch(log)).toBe(launch)
  switchSession(asSessionId(forkId))
  storage.restoreSessionMetadata(log)
  expect(epoch(await reader()({}))).toBe(launch)
})

test('the exact launch survives precompact skipping and a later metadata reappend', async () => {
  const sessionId = randomUUID() as UUID
  const path = join(root, 'compacted.jsonl')
  const boundary = {
    ...createCompactBoundaryMessage('manual', 10),
    sessionId,
    cwd: root,
    isSidechain: false,
    parentUuid: null,
    version: 'test',
  }
  const leaf = {
    ...createUserMessage({ content: 'after compact' }),
    sessionId,
    cwd: root,
    isSidechain: false,
    parentUuid: boundary.uuid,
    version: 'test',
  }
  await writeFile(
    path,
    [
      { type: 'session-started-at', sessionId, startedAt: launch },
      { type: 'progress', padding: 'x'.repeat(6 * 1024 * 1024) },
      boundary,
      leaf,
      { type: 'session-started-at', sessionId, startedAt: launch },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )
  expect(epoch(await storage.loadTranscriptFromFile(path))).toBe(launch)
  const { loadMessagesFromJsonlPath } =
    await import('../../utils/conversationRecovery.js')
  expect(epoch(await loadMessagesFromJsonlPath(path))).toBe(launch)
})

test('all public resume sources carry the epoch through the actual recovery loader', async () => {
  const sessionId = randomUUID() as UUID
  const path = join(root, 'recovery.jsonl')
  await writeFile(
    path,
    [
      { type: 'session-started-at', sessionId, startedAt: launch },
      {
        ...createUserMessage({ content: 'saved' }),
        sessionId,
        cwd: root,
        isSidechain: false,
        parentUuid: null,
        version: 'test',
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  )
  const { loadConversationForResume } =
    await import('../../utils/conversationRecovery.js')
  const log = await storage.loadTranscriptFromFile(path)
  for (const loaded of [
    await loadConversationForResume(log, undefined),
    await loadConversationForResume(sessionId, path),
  ]) {
    expect(loaded?.sessionId).toBe(sessionId)
    expect(epoch(loaded)).toBe(launch)
    switchSession(asSessionId(sessionId))
    storage.restoreSessionMetadata(loaded!)
    expect(epoch(await reader()({}))).toBe(launch)
  }
})

test('same-ID switching preserves the epoch and assigning a fresh custom ID can preserve startup', async () => {
  const sessionId = getSessionId()
  now += 100000
  switchSession(asSessionId(sessionId))
  expect(epoch(await reader()({}))).toBe(launch)
  switchSession(asSessionId(randomUUID()), null, launch)
  expect(epoch(await reader()({}))).toBe(launch)
})

test('the native branch command persists its own launch instead of inheriting the source', async () => {
  const saved = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  try {
    await storage.recordTranscript([
      createUserMessage({ content: 'branch source' }),
    ])
    await storage.flushSessionStorage()
    const sourceId = getSessionId()
    now += 12345
    const { call } = await import('../../commands/branch/branch.js')
    let fork:
      | {
          id: string
          log: import('../../types/logs.js').LogOption
          entrypoint: string
        }
      | undefined
    const notices: string[] = []
    await call(
      (message) => {
        notices.push(message)
      },
      {
        resume: async (id, log, entrypoint) => {
          fork = { id, log, entrypoint }
        },
      } as Parameters<typeof call>[1],
      'native-launch-test',
    )
    expect(fork).toBeDefined()
    expect(fork!.id).not.toBe(sourceId)
    expect(fork!.entrypoint).toBe('fork')
    expect(epoch(fork!.log)).toBe(now)
    const reread = await storage.loadTranscriptFromFile(fork!.log.fullPath!)
    expect(reread.sessionId).toBe(fork!.id)
    expect(epoch(reread)).toBe(now)
    expect(notices.join('\n')).toContain('Branched conversation')
    expect(getSessionId()).toBe(sourceId)
  } finally {
    if (saved === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = saved
  }
})

test('disabled persistence cannot append new launch metadata through resumed-file adoption', async () => {
  const saved = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  try {
    await storage.recordTranscript([
      createUserMessage({ content: 'existing saved session' }),
    ])
    await storage.flushSessionStorage()
    const path = storage.getTranscriptPath()
    const before = await readFile(path, 'utf8')
    await storage.resetSessionFilePointer()
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    storage.adoptResumedSessionFile()
    await storage.flushSessionStorage()
    expect(await readFile(path, 'utf8')).toBe(before)
  } finally {
    if (saved === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = saved
  }
})

test('restoring unrelated session metadata cannot copy its launch', async () => {
  now += 100000
  regenerateSessionId()
  storage.restoreSessionMetadata({
    sessionId: randomUUID(),
    startedAt: launch,
  } as never)
  expect(epoch(await reader()({}))).toBe(now)
})

test('historical transcripts without a launch never use first prompt or file times as a substitute', async () => {
  const sessionId = randomUUID() as UUID
  const path = join(root, 'legacy.jsonl')
  await writeFile(
    path,
    JSON.stringify({
      ...createUserMessage({ content: 'legacy' }),
      sessionId,
      cwd: root,
      isSidechain: false,
      parentUuid: null,
      version: 'test',
      timestamp: '2020-01-01T00:00:00.000Z',
    }) + '\n',
  )
  const log = await storage.loadTranscriptFromFile(path)
  expect(epoch(log)).toBeUndefined()
  switchSession(asSessionId(sessionId))
  storage.restoreSessionMetadata({ ...log, sessionId })
  expect(epoch(await reader()({}))).toBe(now)
})

test('invalid persisted launch metadata is not admitted as an exact epoch', async () => {
  const sessionId = randomUUID() as UUID
  for (const startedAt of [-1, 1.5, '123', null, Number.MAX_SAFE_INTEGER + 1]) {
    const path = join(root, `invalid-${String(startedAt)}.jsonl`)
    await writeFile(
      path,
      [
        { type: 'session-started-at', sessionId, startedAt },
        {
          ...createUserMessage({ content: 'saved' }),
          sessionId,
          cwd: root,
          isSidechain: false,
          parentUuid: null,
          version: 'test',
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    )
    expect(epoch(await storage.loadTranscriptFromFile(path))).toBeUndefined()
  }
})
