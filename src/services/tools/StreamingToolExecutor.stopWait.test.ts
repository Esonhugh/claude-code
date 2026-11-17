import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { getIsInteractive, setIsInteractive } from '../../bootstrap/state.js'
import {
  resetCodeModeGateForTesting,
  settleCodeModeGate,
} from '../../tools/REPLTool/codeModeGate.js'
import type { Message } from '../../types/message.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { createAssistantMessage, REJECT_MESSAGE } from '../../utils/messages.js'
import {
  setStoppedResultWaitMsForTesting,
  StreamingToolExecutor,
  STOPPED_RESULT_WAIT_MS,
} from './StreamingToolExecutor.js'

const originalSettings = getSessionSettingsCache()
setSessionSettingsCache({ settings: {}, errors: [] })
for (const source of ['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings'] as const)
  setCachedSettingsForSource(source, {})
afterAll(() => {
  resetSettingsCache()
  if (originalSettings) setSessionSettingsCache(originalSettings)
})

const envKeys = ['CLAUDE_CODE_EXPERIMENTAL_CODE_MODE', 'CLAUDE_CODE_ENTRYPOINT'] as const
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
const savedInteractive = getIsInteractive()

beforeEach(() => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE = '1'
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
  setIsInteractive(true)
  resetCodeModeGateForTesting()
  settleCodeModeGate({ remoteControl: false, remote: false })
})

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setIsInteractive(savedInteractive)
  resetCodeModeGateForTesting()
  setStoppedResultWaitMsForTesting(undefined)
})

const STOP_REPORT = 'The user interrupted this script, so it stopped.'

/**
 * A tool that runs until the turn is stopped, then (unless `answers` is
 * false) reports progress and returns a stopped result, as REPL does.
 */
function fixture(name: string, o: { answers?: boolean; stoppedBy?: string } = {}) {
  const entered = Promise.withResolvers<void>()
  const tool = {
    name,
    inputSchema: z.object({ code: z.string() }),
    maxResultSizeChars: Infinity,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    interruptBehavior: () => 'cancel',
    call: async (
      input: { code: string },
      context: ToolUseContext,
      _canUseTool: unknown,
      _assistant: unknown,
      onProgress?: (progress: { toolUseID: string; data: unknown }) => void,
    ) => {
      entered.resolve()
      const { signal } = context.abortController
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      if (o.answers === false) await new Promise(() => {})
      onProgress?.({ toolUseID: 'stop-progress', data: { type: 'repl_tool_call', phase: 'error' } })
      await new Promise(resolve => setTimeout(resolve, 5))
      return { data: { code: input.code, output: STOP_REPORT, stoppedBy: o.stoppedBy ?? 'user' } }
    },
    mapToolResultToToolResultBlockParam: (data: { output: string }, id: string) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: data.output,
    }),
  } as unknown as Tool
  const context = {
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: false },
    abortController: new AbortController(),
    messages: [],
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
  } as unknown as ToolUseContext
  const block = {
    type: 'tool_use' as const,
    caller: { type: 'direct' as const },
    id: 'stop-1',
    name,
    input: { code: 'await sleep(60000)' },
  }
  const executor = new StreamingToolExecutor([tool], async () => ({ behavior: 'allow' as const }), context)
  executor.addTool(block, createAssistantMessage({ content: [block] }))
  return { context, entered: entered.promise, executor }
}

async function stopTurn(f: ReturnType<typeof fixture>, reason: unknown = 'user-cancel') {
  const results = Array.fromAsync(f.executor.getRemainingResults())
  await f.entered
  f.context.abortController.abort(reason)
  return (await results).map(update => update.message).filter((m): m is Message => m !== undefined)
}

function toolResult(messages: Message[]) {
  const results = messages.filter(
    m => m.type === 'user' && Array.isArray(m.message.content) && m.message.content.some(p => p.type === 'tool_result'),
  )
  const message = results[0]
  if (message?.type !== 'user' || !Array.isArray(message.message.content)) throw new Error('no tool_result')
  const part = message.message.content.find(p => p.type === 'tool_result')!
  const text =
    part.type !== 'tool_result'
      ? ''
      : typeof part.content === 'string'
        ? part.content
        : ((part.content ?? []) as Array<{ type: string; text?: string }>).map(b => b.text ?? '').join('\n')
  return { text, kind: message.toolDenialKind, count: results.length }
}

describe('stopped REPL result wait (official stoppedResultWait)', () => {
  test('waits the official 10 s', () => {
    expect(STOPPED_RESULT_WAIT_MS).toBe(10_000)
  })

  test('Esc while REPL runs sends its stopped result, marked as a user stop', async () => {
    const f = fixture('REPL')
    const messages = await stopTurn(f)
    const result = toolResult(messages)
    expect(result.text).toBe(
      `${STOP_REPORT}\nThe user stopped this call. STOP what you are doing and wait for the user to tell you how to proceed.`,
    )
    expect(result.kind).toBe('user-rejected')
    expect(result.count).toBe(1)
    expect(messages.some(m => m.type === 'progress')).toBe(true)
  })

  test('a declined prompt (abort with no reason) waits too', async () => {
    const f = fixture('REPL', { stoppedBy: 'refusal' })
    const controller = new AbortController()
    controller.abort()
    const result = toolResult(await stopTurn(f, controller.signal.reason))
    expect(result.text).toStartWith(STOP_REPORT)
  })

  test('REPL that does not answer in time gets REJECT_MESSAGE', async () => {
    setStoppedResultWaitMsForTesting(30)
    const f = fixture('REPL', { answers: false })
    const result = toolResult(await stopTurn(f))
    expect(result.text).toStartWith(REJECT_MESSAGE)
    expect(result.kind).toBe('user-rejected')
    expect(result.count).toBe(1)
  })

  test('another tool still gets REJECT_MESSAGE', async () => {
    const f = fixture('Slow')
    const result = toolResult(await stopTurn(f))
    expect(result.text).toStartWith(REJECT_MESSAGE)
  })

  test('a stop that is not the user (backgrounding) does not wait', async () => {
    const f = fixture('REPL')
    const result = toolResult(await stopTurn(f, 'background'))
    expect(result.text).toStartWith(REJECT_MESSAGE)
  })

  test('REPL outside Code Mode does not wait', async () => {
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE
    resetCodeModeGateForTesting()
    const f = fixture('REPL')
    const result = toolResult(await stopTurn(f))
    expect(result.text).toStartWith(REJECT_MESSAGE)
  })
})
