import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const envKeys = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'CLAUDE_CODE_EXTRA_BODY',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
for (const key of envKeys) delete process.env[key]
beforeEach(() => {
  for (const key of envKeys) delete process.env[key]
})

const requests: MessageCreateParams[] = []
let rejectIncompatibleEffort = false
let streamNotFound = false
const client = new Anthropic({
  apiKey: 'test-only',
  maxRetries: 0,
  timeout: 600_000,
  fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as MessageCreateParams
    requests.push(request)
    if (rejectIncompatibleEffort) {
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'thinking disabled is incompatible with xhigh/max effort',
          },
        },
        { status: 400 },
      )
    }
    if (streamNotFound && request.stream) {
      return Response.json(
        {
          type: 'error',
          error: { type: 'not_found_error', message: 'stream unsupported' },
        },
        { status: 404 },
      )
    }
    const message = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: request.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    if (!request.stream) {
      return Response.json({
        ...message,
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
      })
    }
    const events = [
      { type: 'message_start', message },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'OK' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(''),
      {
        headers: {
          'content-type': 'text/event-stream',
          'request-id': 'req_test',
        },
      },
    )
  },
})

mock.module('./client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  getAnthropicClient: async () => client,
}))

mock.module('../vcr.js', () => ({
  withStreamingVCR: (_messages: unknown, run: () => AsyncGenerator<unknown>) =>
    run(),
  withVCR: (_messages: unknown, run: () => Promise<unknown>) => run(),
  withTokenCountVCR: (_input: unknown, run: () => Promise<unknown>) => run(),
}))

const { spyOn } = await import('bun:test')
const auth = await import('../../utils/auth.js')
spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(false)
spyOn(auth, 'getOauthAccountInfo').mockReturnValue(undefined)
const growthbook = await import('../analytics/growthbook.js')
spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation(
  (_key, fallback) => fallback,
)
spyOn(growthbook, 'getDynamicConfig_BLOCKS_ON_INIT').mockImplementation(
  async (_key, fallback) => fallback,
)

const { queryModelWithoutStreaming, queryWithModel, queryHaiku, verifyApiKey } =
  await import('./claude.js')
const { createUserMessage } = await import('../../utils/messages.js')
const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')

async function query(
  model: string,
  thinkingConfig: Parameters<
    typeof queryModelWithoutStreaming
  >[0]['thinkingConfig'],
  expectedError?: string,
) {
  const result = await queryModelWithoutStreaming({
    messages: [createUserMessage({ content: 'test' })],
    systemPrompt: asSystemPrompt([]),
    thinkingConfig,
    tools: [],
    signal: new AbortController().signal,
    options: {
      model,
      querySource: 'repl_main_thread',
      agents: [],
      mcpTools: [],
      hasAppendSystemPrompt: false,
      isNonInteractiveSession: true,
      enablePromptCaching: false,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    },
  })
  if (expectedError) {
    expect(JSON.stringify(result.message.content)).toContain(expectedError)
  } else {
    expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  }
  expect(requests).toHaveLength(streamNotFound ? 2 : 1)
  return requests[0]!
}

afterAll(() => {
  mock.restore()
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

afterEach(() => {
  requests.length = 0
  rejectIncompatibleEffort = false
  streamNotFound = false
})

test.each(['claude-opus-5', 'claude-sonnet-5'])(
  '%s explicitly disables thinking on the wire without sampling defaults',
  async (model) => {
    const request = await query(model, { type: 'disabled' })
    expect(request.thinking).toEqual({ type: 'disabled' })
    expect(request.temperature).toBeUndefined()
  },
)

test.each(['claude-opus-5', 'claude-sonnet-5'])(
  '%s uses adaptive instead of legacy manual budgets',
  async (model) => {
    const request = await query(model, { type: 'enabled', budgetTokens: 1234 })
    expect(request.thinking).toEqual({ type: 'adaptive' })
    expect(request.temperature).toBeUndefined()
  },
)

test.each([
  'CLAUDE_CODE_DISABLE_THINKING',
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
])('%s cannot fall back to an invalid manual budget', async (env) => {
  process.env[env] = '1'
  const request = await query('claude-opus-5', { type: 'adaptive' })
  expect(request.thinking).toEqual({ type: 'disabled' })
})

test('explicit incompatible effort and extra body parameters remain intact', async () => {
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max'
  process.env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({
    temperature: 0.2,
    top_p: 0.7,
    top_k: 4,
  })
  const request = await query('claude-opus-5', { type: 'disabled' })
  expect(request.model).toBe('claude-opus-5')
  expect(request.thinking).toEqual({ type: 'disabled' })
  expect(request.output_config?.effort).toBe('max')
  expect(request.temperature).toBe(0.2)
  expect(request.top_p).toBe(0.7)
  expect(request.top_k).toBe(4)
})

test.each(['xhigh', 'max', 'ultracode'])(
  'explicit disabled + %s surfaces 400 without lowering effort or changing model',
  async (effort) => {
    rejectIncompatibleEffort = true
    process.env.CLAUDE_CODE_EFFORT_LEVEL = effort
    const request = await query(
      'claude-opus-5',
      { type: 'disabled' },
      'thinking disabled is incompatible',
    )
    expect(request.model).toBe('claude-opus-5')
    expect(request.output_config).toMatchObject({
      effort: effort === 'ultracode' ? 'xhigh' : effort,
    })
    expect(request.thinking).toEqual({ type: 'disabled' })
  },
)

test('non-streaming fallback retains adaptive parameters and model identity', async () => {
  streamNotFound = true
  await query('claude-sonnet-5', { type: 'adaptive' })
  const request = requests[1]!
  expect(request.stream).not.toBe(true)
  expect(request.model).toBe('claude-sonnet-5')
  expect(request.thinking).toEqual({ type: 'adaptive' })
  expect(request.temperature).toBeUndefined()
  expect(request.max_tokens).toBe(32_000)
})

test('explicit output budget overrides the new model default', async () => {
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '48000'
  const request = await query('claude-sonnet-5', { type: 'adaptive' })
  expect(request.max_tokens).toBe(48_000)
})

test('small-fast override to Opus 5 defaults to adaptive without legacy sampling', async () => {
  process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-opus-5'
  await queryHaiku({
    systemPrompt: asSystemPrompt([]),
    userPrompt: 'test',
    signal: new AbortController().signal,
    options: {
      querySource: 'compact',
      agents: [],
      mcpTools: [],
      hasAppendSystemPrompt: false,
      isNonInteractiveSession: true,
      temperatureOverride: 0,
    },
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]!.thinking).toEqual({ type: 'adaptive' })
  expect(requests[0]!.temperature).toBeUndefined()
})

test('key verification with a new small-fast model explicitly disables thinking', async () => {
  process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-opus-5'
  expect(await verifyApiKey('test-only', false)).toBe(true)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.thinking).toEqual({ type: 'disabled' })
  expect(requests[0]!.temperature).toBeUndefined()
})

test('legacy models retain disabled sampling and manual-budget behavior', async () => {
  const disabled = await query('claude-sonnet-4-5', { type: 'disabled' })
  expect(disabled.thinking).toBeUndefined()
  expect(disabled.temperature).toBe(1)
  requests.length = 0
  const enabled = await query('claude-sonnet-4-5', {
    type: 'enabled',
    budgetTokens: 1234,
  })
  expect(enabled.thinking).toEqual({ type: 'enabled', budget_tokens: 1234 })
})

test('internal queries honor explicitly disabled default thinking', async () => {
  process.env.MAX_THINKING_TOKENS = '0'
  try {
    await queryWithModel({
      systemPrompt: asSystemPrompt([]),
      userPrompt: 'test',
      signal: new AbortController().signal,
      options: {
        model: 'claude-opus-5',
        querySource: 'compact',
        agents: [],
        mcpTools: [],
        hasAppendSystemPrompt: false,
        isNonInteractiveSession: true,
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.thinking).toEqual({ type: 'disabled' })
    expect(requests[0]!.temperature).toBeUndefined()
  } finally {
    delete process.env.MAX_THINKING_TOKENS
  }
})

test.each(['claude-opus-5', 'claude-sonnet-5'])(
  '%s internal queries default to adaptive and omit legacy sampling overrides',
  async (model) => {
    await queryWithModel({
      systemPrompt: asSystemPrompt([]),
      userPrompt: 'test',
      signal: new AbortController().signal,
      options: {
        model,
        querySource: 'compact',
        agents: [],
        mcpTools: [],
        hasAppendSystemPrompt: false,
        isNonInteractiveSession: true,
        temperatureOverride: 0,
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.thinking).toEqual({ type: 'adaptive' })
    expect(requests[0]!.temperature).toBeUndefined()
  },
)
