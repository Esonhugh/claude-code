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

const settingsModule = await import('../../utils/settings/settings.js')
const claudeApi = await import('../../services/api/claude.js')
const { buildSummaryNotes, normalizeSummaryLabel } = await import('./agentSummary.js')

async function withSummaryHarness(
  name: string,
  settings: Record<string, unknown>,
  body: (h: {
    tick: () => Promise<number>
    start: (ownRequests?: Parameters<typeof startAgentSummarization>[4]) => () => void
    fork: ReturnType<typeof spyOn>
    query: ReturnType<typeof spyOn>
  }) => Promise<void>,
) {
  const agentId = asAgentId(name)
  const messages = [
    createUserMessage({ content: 'Fix the login bug' }),
    createAssistantMessage({ content: 'Looking at auth.ts' }),
    createUserMessage({ content: 'keep going' }),
  ]
  await recordSidechainTranscript(messages, agentId)
  await flushSessionStorage()
  let state = { ...getDefaultAppState(), tasks: {} } as unknown as AppState
  const setAppState = (fn: (prev: AppState) => AppState) => {
    state = fn(state)
  }
  const timers: Array<{ run: () => unknown; delay: number }> = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((handler: () => unknown, delay?: number, ...args: unknown[]) => {
    if (delay === 30_000 || delay === 2_000) {
      timers.push({ run: handler, delay })
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    return realSetTimeout(handler, delay, ...args)
  }) as typeof setTimeout
  const realSettings = settingsModule.getInitialSettings()
  const settingsSpy = spyOn(settingsModule, 'getInitialSettings').mockImplementation(
    () => ({ ...realSettings, ...settings }) as never,
  )
  const fork = spyOn(forkedAgent, 'runForkedAgent').mockImplementation(
    async () => ({ messages: [createAssistantMessage({ content: 'Reading auth.ts' })] }) as never,
  )
  const query = spyOn(claudeApi, 'queryWithModel').mockImplementation(
    async () => createAssistantMessage({ content: 'Reading auth.ts' }) as never,
  )
  try {
    await body({
      tick: async () => {
        const next = timers.shift()
        assert.ok(next, 'summary timer was not scheduled')
        await next.run()
        return timers[0]?.delay ?? 0
      },
      start: ownRequests =>
        startAgentSummarization(name, agentId, {
          toolUseContext: { options: { mainLoopModel: 'claude-opus-5-5', isNonInteractiveSession: false } },
        } as never, setAppState, ownRequests).stop,
      fork,
      query,
    })
  } finally {
    fork.mockRestore()
    query.mockRestore()
    settingsSpy.mockRestore()
    globalThis.setTimeout = realSetTimeout
  }
}

test('agentSummary "off" makes no summary request', async () => {
  await withSummaryHarness('summary-off-agent', { agentSummary: 'off' }, async h => {
    const stop = h.start()
    try {
      expect(await h.tick()).toBe(30_000)
      expect(h.fork).not.toHaveBeenCalled()
      expect(h.query).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})

test('agentSummary "short" sends notes instead of forking the transcript', async () => {
  await withSummaryHarness('summary-short-agent', { agentSummary: 'short' }, async h => {
    const stop = h.start()
    try {
      await h.tick()
      expect(h.fork).not.toHaveBeenCalled()
      expect(h.query).toHaveBeenCalledTimes(1)
      const [{ userPrompt, options }] = h.query.mock.calls[0] as [{ userPrompt: string; options: Record<string, unknown> }]
      expect(userPrompt).toContain('<task>\nFix the login bug\n</task>')
      expect(userPrompt).toContain('said: Looking at auth.ts')
      expect(options).toMatchObject({ querySource: 'agent_summary', enablePromptCaching: false, model: 'claude-opus-5-5' })
      await h.tick()
      expect(h.query).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })
})

test('full summary holds while the sub-agent request is cold and unanswered', async () => {
  await withSummaryHarness('summary-hold-agent', {}, async h => {
    const own = { requestsBegun: 1, responsesBegun: 0, isAwaitingResponse: true, lastResponseAt: undefined }
    const stop = h.start(own)
    try {
      expect(await h.tick()).toBe(2_000)
      expect(await h.tick()).toBe(2_000)
      expect(h.fork).not.toHaveBeenCalled()
      own.responsesBegun = 1
      own.isAwaitingResponse = false
      own.lastResponseAt = Date.now() as never
      expect(await h.tick()).toBe(30_000)
      expect(h.fork).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })
})

test('full summary does not hold when the sub-agent cache is warm', async () => {
  await withSummaryHarness('summary-warm-agent', {}, async h => {
    const stop = h.start({ requestsBegun: 2, responsesBegun: 1, isAwaitingResponse: true, lastResponseAt: Date.now() })
    try {
      await h.tick()
      expect(h.fork).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })
})

test('buildSummaryNotes lists finished and open steps', () => {
  const call = createAssistantMessage({
    content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bun test', description: 'Run tests' } },
    ] as never,
  })
  const done = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: true }] as never })
  const open = createAssistantMessage({
    content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/a/<b>.ts' } }] as never,
  })
  expect(buildSummaryNotes('Fix it', [createUserMessage({ content: 'Fix it' }), call, done, open])).toBe(
    '<task>\nFix it\n</task>\n<recent_steps>\ndid: Bash - Run tests (failed)\n</recent_steps>\n<started_not_finished>\nRead - /a/&lt;b&gt;.ts\n</started_not_finished>',
  )
  expect(buildSummaryNotes('Fix it', [createUserMessage({ content: 'Fix it' })])).toBe('')
})

test('normalizeSummaryLabel rejects multi-line and markdown replies', () => {
  expect(normalizeSummaryLabel('  `Reading auth.ts`  ')).toBe('Reading auth.ts')
  expect(normalizeSummaryLabel('<label>Running tests</label>')).toBe('Running tests')
  expect(normalizeSummaryLabel('Reading\nauth.ts')).toBeNull()
  expect(normalizeSummaryLabel('# Heading')).toBeNull()
  expect(normalizeSummaryLabel('x'.repeat(101))).toBeNull()
})
