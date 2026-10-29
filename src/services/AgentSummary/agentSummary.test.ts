import assert from 'node:assert/strict'
import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getDefaultAppState, type AppState } from '../../state/AppState.js'
import { asAgentId } from '../../types/ids.js'
import * as forkedAgent from '../../utils/forkedAgent.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import {
  flushSessionStorage,
  getAgentTranscript,
  recordSidechainTranscript,
} from '../../utils/sessionStorage.js'

const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
const configDir = mkdtempSync(join(tmpdir(), 'agent-summary-test-'))
process.env.CLAUDE_CONFIG_DIR = configDir
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.ANTHROPIC_API_KEY ??= 'test-only-not-a-real-key'

const { startAgentSummarization } = await import('./agentSummary.js')

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalTestPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  rmSync(configDir, { recursive: true, force: true })
})

test('C7 unchanged transcript skips the summary fork', async () => {
  const agentId = asAgentId('summary-unchanged-agent')
  const initial = [
    createUserMessage({ content: 'first prompt' }),
    createAssistantMessage({ content: 'first answer' }),
    createUserMessage({ content: 'second prompt' }),
  ]
  await recordSidechainTranscript(initial, agentId)
  await flushSessionStorage()
  assert.equal((await getAgentTranscript(agentId))?.messages.length, 3)

  let state = { ...getDefaultAppState(), tasks: {} } as unknown as AppState
  const setAppState = (fn: (prev: AppState) => AppState) => {
    state = fn(state)
  }
  const summaryTimers: Array<() => unknown> = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((
    handler: () => unknown,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 30_000) {
      summaryTimers.push(handler)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    return realSetTimeout(handler, delay, ...args)
  }) as typeof setTimeout
  const fork = spyOn(forkedAgent, 'runForkedAgent').mockImplementation(
    async () => ({
      messages: [createAssistantMessage({ content: 'Reading foo.ts' })],
    }) as never,
  )
  const tick = async () => {
    const run = summaryTimers.shift()
    assert.ok(run, 'summary timer was not scheduled')
    await run()
  }
  try {
    const { stop } = startAgentSummarization(
      'summary-task',
      agentId,
      { toolUseContext: {} } as never,
      setAppState,
    )
    try {
      await tick()
      expect(fork).toHaveBeenCalledTimes(1)
      // One reply, and no cache entry for the fork's own tail (official 2.1.311).
      expect(fork.mock.calls[0]![0]).toMatchObject({
        maxTurns: 1,
        skipCacheWrite: true,
      })
      await tick()
      expect(fork).toHaveBeenCalledTimes(1)

      await recordSidechainTranscript(
        [createUserMessage({ content: 'third prompt' })],
        agentId,
        initial[2]!.uuid,
      )
      await flushSessionStorage()
      await tick()
      expect(fork).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  } finally {
    fork.mockRestore()
    globalThis.setTimeout = realSetTimeout
  }
})
