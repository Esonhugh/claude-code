import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { setIsInteractive } from '../bootstrap/state.js'
import type { Message } from '../types/message.js'
import type { CacheSafeParams, ForkedAgentParams } from '../utils/forkedAgent.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from '../utils/messages.js'

const actualForkedAgent = await import('../utils/forkedAgent.js')

let savedParams: CacheSafeParams | null = null
let forkCalls: ForkedAgentParams[] = []
let forkReply: () => Promise<Message[]> = async () => []

mock.module('../utils/forkedAgent.js', () => ({
  ...actualForkedAgent,
  getLastCacheSafeParams: () => savedParams,
  runForkedAgent: async (params: ForkedAgentParams) => {
    forkCalls.push(params)
    return { messages: await forkReply(), totalUsage: {} }
  },
}))

const { capRecapText, generateAwaySummary, isAwaySummaryEnabled } =
  await import('./awaySummary.js')
const { call: recapCall } = await import('../commands/recap/recap.js')

function params(messages: Message[]): CacheSafeParams {
  return {
    systemPrompt: [] as never,
    userContext: {},
    systemContext: {},
    toolUseContext: {} as never,
    forkContextMessages: messages,
  }
}

const conversation = [createUserMessage({ content: 'fix the login bug' })]
const envKey = 'CLAUDE_CODE_ENABLE_AWAY_SUMMARY'
let savedEnv: string | undefined

beforeEach(() => {
  savedParams = null
  forkCalls = []
  forkReply = async () => []
  savedEnv = process.env[envKey]
  delete process.env[envKey]
  setIsInteractive(true)
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[envKey]
  else process.env[envKey] = savedEnv
})

describe('isAwaySummaryEnabled', () => {
  test('defaults on in interactive sessions without any remote gate', () => {
    expect(isAwaySummaryEnabled()).toBe(true)
  })

  test('defaults off in non-interactive sessions', () => {
    setIsInteractive(false)
    expect(isAwaySummaryEnabled()).toBe(false)
  })

  test('CLAUDE_CODE_ENABLE_AWAY_SUMMARY forces it on or off', () => {
    process.env[envKey] = '0'
    expect(isAwaySummaryEnabled()).toBe(false)
    setIsInteractive(false)
    process.env[envKey] = '1'
    expect(isAwaySummaryEnabled()).toBe(true)
  })
})

describe('capRecapText', () => {
  test('keeps short text and cuts long text at a word boundary', () => {
    expect(capRecapText('short recap')).toBe('short recap')
    const capped = capRecapText('word '.repeat(200))
    expect(capped.length).toBeLessThanOrEqual(400)
    expect(capped.endsWith('word…')).toBe(true)
  })
})

describe('generateAwaySummary', () => {
  test('returns no-turn before any turn has completed', async () => {
    const result = await generateAwaySummary(new AbortController().signal)
    expect(result).toEqual({ kind: 'no-turn' })
    expect(forkCalls).toHaveLength(0)
  })

  test('forks the main conversation with tools denied and strips memory tags', async () => {
    savedParams = params(conversation)
    forkReply = async () => [
      createAssistantMessage({
        content:
          '<cc-memory filenames="a.md">Fixing the login bug.</cc-memory> Next: add a test.',
      }),
    ]
    const result = await generateAwaySummary(new AbortController().signal)
    expect(result).toEqual({
      kind: 'ok',
      text: 'Fixing the login bug. Next: add a test.',
      capped: false,
    })
    const call = forkCalls[0]!
    expect(call.cacheSafeParams).toBe(savedParams)
    expect(call.querySource).toBe('away_summary')
    expect(call.maxTurns).toBe(1)
    expect(call.skipTranscript).toBe(true)
    const decision = await call.canUseTool(
      ...([] as unknown as Parameters<typeof call.canUseTool>),
    )
    expect(decision.behavior).toBe('deny')
  })

  test('reports API errors and caps long recaps', async () => {
    savedParams = params(conversation)
    forkReply = async () => [
      createAssistantAPIErrorMessage({ content: 'API Error: overloaded' }),
    ]
    expect(await generateAwaySummary(new AbortController().signal)).toEqual({
      kind: 'api-error',
      text: 'API Error: overloaded',
    })

    forkReply = async () => [createAssistantMessage({ content: 'step '.repeat(200) })]
    const result = await generateAwaySummary(new AbortController().signal)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.capped).toBe(true)
      expect(result.text.length).toBeLessThanOrEqual(400)
    }
  })

  test('uses fallback params when no turn was saved and reports failures', async () => {
    forkReply = async () => [createAssistantMessage({ content: 'Recap.' })]
    const fallback = params(conversation)
    expect(
      await generateAwaySummary(new AbortController().signal, async () => fallback),
    ).toEqual({ kind: 'ok', text: 'Recap.', capped: false })
    expect(forkCalls[0]!.cacheSafeParams).toBe(fallback)

    expect(
      await generateAwaySummary(new AbortController().signal, async () => {
        throw new Error('boom')
      }),
    ).toEqual({ kind: 'failed' })

    forkReply = async () => {
      throw new Error('network down')
    }
    savedParams = fallback
    expect(await generateAwaySummary(new AbortController().signal)).toEqual({
      kind: 'failed',
    })
  })

  test('returns aborted when the caller aborts', async () => {
    savedParams = params(conversation)
    const controller = new AbortController()
    forkReply = async () => {
      controller.abort()
      return [createAssistantMessage({ content: 'late' })]
    }
    expect(await generateAwaySummary(controller.signal)).toEqual({
      kind: 'aborted',
    })
  })
})

describe('/recap', () => {
  function context(messages: Message[]) {
    return {
      messages,
      abortController: new AbortController(),
      options: { tools: [], mainLoopModel: 'test-model', mcpClients: [] },
    } as never
  }

  test('asks for a message first when there is nothing to recap', async () => {
    expect(await recapCall('', context([]))).toEqual({
      type: 'text',
      value: 'Nothing to recap yet — send a message first.',
    })
  })

  test('prints the recap text and the official failure message', async () => {
    savedParams = params(conversation)
    forkReply = async () => [createAssistantMessage({ content: 'Working on login.' })]
    expect(await recapCall('', context(conversation))).toEqual({
      type: 'text',
      value: 'Working on login.',
    })
    forkReply = async () => []
    expect(await recapCall('', context(conversation))).toEqual({
      type: 'text',
      value: "Couldn't generate a recap. Run with --debug for details.",
    })
  })
})
