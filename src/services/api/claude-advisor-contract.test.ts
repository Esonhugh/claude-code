import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

// Bun module mocks outlive mock.restore(); keep them in a private child
// process like claude-model-contract.test.ts.
if (process.env.CLAUDE_ADVISOR_CONTRACT_CHILD !== import.meta.path) {
  test('offline model contracts in an isolated process', async () => {
    const { mkdir, mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'claude-advisor-contract-'))
    try {
      await mkdir(join(root, 'config'))
      const child = Bun.spawn([
        process.execPath, 'test', '--no-env-file',
        import.meta.path, '--timeout', '20000',
      ], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          XDG_CONFIG_HOME: join(root, 'config'),
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_ADVISOR_CONTRACT_CHILD: import.meta.path,
          ANTHROPIC_API_KEY: 'test-only',
          ANTHROPIC_BASE_URL: 'https://provider.invalid',
          NODE_ENV: 'test',
          CI: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const deadline = setTimeout(() => child.kill(), 60_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        process.stdout.write(stdout)
        process.stderr.write(stderr)
        expect(exitCode).toBe(0)
      } finally {
        clearTimeout(deadline)
        if (child.exitCode === null) {
          child.kill()
          await child.exited
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 65_000)
} else {
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const envKeys = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
  'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'ANTHROPIC_BETAS',
] as const
for (const key of envKeys) delete process.env[key]

const ADVISOR_BETA = 'advisor-tool-2026-03-01'
const requests: MessageCreateParams[] = []
const requestBetaHeaders: string[] = []
// Refuse requests that carry the advisor tool (or, for 'beta', the header).
// 'blocks' refuses requests whose history still carries ADVICE_TEXT.
let refusal: { status: number; message: string; on: 'tool' | 'beta' | 'blocks' } | undefined
const hasAdvisorTool = (request: MessageCreateParams) =>
  (request.tools ?? []).some(t => (t as { type?: string }).type === 'advisor_20260301')
const client = new Anthropic({
  apiKey: 'test-only',
  maxRetries: 0,
  timeout: 600_000,
  fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as MessageCreateParams
    const beta = new Headers(init?.headers).get('anthropic-beta') ?? ''
    requests.push(request)
    requestBetaHeaders.push(beta)
    if (
      refusal &&
      (refusal.on === 'tool'
        ? hasAdvisorTool(request)
        : refusal.on === 'beta'
          ? beta.includes(ADVISOR_BETA)
          : JSON.stringify(request.messages).includes('ADVICE_TEXT'))
    ) {
      return Response.json(
        { type: 'error', error: { type: 'invalid_request_error', message: refusal.message } },
        { status: refusal.status },
      )
    }
    const message = {
      id: 'msg_test', type: 'message', role: 'assistant', model: request.model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const events = [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return new Response(
      events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } },
    )
  },
})

mock.module('./client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  getAnthropicClient: async () => client,
  getCustomHeaders: () => ({}),
}))

mock.module('../vcr.js', () => ({
  withStreamingVCR: (_messages: unknown, run: () => AsyncGenerator<unknown>) =>
    run(),
  withVCR: (_messages: unknown, run: () => Promise<unknown>) => run(),
  withTokenCountVCR: (
    _messages: unknown,
    _tools: unknown,
    _model: unknown,
    run: () => Promise<unknown>,
  ) => run(),
}))

const { spyOn } = await import('bun:test')
const unexpectedIO: string[] = []
function denyIO(kind: string): never {
  unexpectedIO.push(kind)
  throw new Error(`Unexpected offline contract I/O: ${kind}`)
}
spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
  async () => denyIO('fetch'),
  { preconnect: () => denyIO('fetch.preconnect') },
))
for (const module of [await import('node:http'), await import('node:https')]) {
  spyOn(module.default, 'request').mockImplementation(() => denyIO('http.request'))
  spyOn(module.default, 'get').mockImplementation(() => denyIO('http.get'))
}
const { default: axios } = await import('axios')
axios.defaults.adapter = async () => denyIO('axios')
mock.module('../../utils/secureStorage/index.js', () => ({
  getSecureStorage: () => ({
    name: 'offline-test',
    read: () => null,
    readAsync: async () => null,
    update: () => denyIO('credential update'),
  }),
}))
const auth = await import('../../utils/auth.js')
spyOn(auth, 'getAnthropicApiKey').mockReturnValue('test-only')
spyOn(auth, 'getAnthropicApiKeyWithSource').mockReturnValue({
  key: 'test-only', source: 'ANTHROPIC_API_KEY',
})
spyOn(auth, 'getClaudeAIOAuthTokens').mockReturnValue(null)
spyOn(auth, 'getClaudeAIOAuthTokensAsync').mockResolvedValue(null)
spyOn(auth, 'checkAndRefreshOAuthTokenIfNeeded').mockResolvedValue(false)
spyOn(auth, 'isClaudeAISubscriber').mockReturnValue(false)
spyOn(auth, 'getOauthAccountInfo').mockReturnValue(undefined)
const growthbook = await import('../analytics/growthbook.js')
// The remote advisor flag says off; the advisor must stay on regardless.
spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation(
  (key, fallback) =>
    (key === 'tengu_sage_compass2' ? { enabled: false } : fallback) as typeof fallback,
)
spyOn(growthbook, 'getDynamicConfig_BLOCKS_ON_INIT').mockImplementation(
  async (_key, fallback) => fallback,
)

spyOn(growthbook, 'checkStatsigFeatureGate_CACHED_MAY_BE_STALE').mockReturnValue(false)
const settingsCache = await import('../../utils/settings/settingsCache.js')
settingsCache.setSessionSettingsCache({ settings: {}, errors: [] })
for (const source of [
  'userSettings', 'projectSettings', 'localSettings', 'policySettings', 'flagSettings',
] as const) settingsCache.setCachedSettingsForSource(source, {})

const { queryModelWithoutStreaming } = await import('./claude.js')
const { createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
const { asSystemPrompt } = await import('../../utils/systemPromptType.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { resetAdvisorRefusalsForTesting, resolveAdvisorModelId } = await import('../../utils/advisor.js')
const { createAttachmentMessage } = await import('../../utils/attachments.js')
const analytics = await import('../analytics/index.js')
const loggedEvents: [string, Record<string, unknown>][] = []
spyOn(analytics, 'logEvent').mockImplementation((name, metadata) => {
  loggedEvents.push([name, metadata as Record<string, unknown>])
})

type QueryOptions = Parameters<typeof queryModelWithoutStreaming>[0]['options']

// An earlier turn that consulted the advisor.
const advised = (advice: string) =>
  createAssistantMessage({
    content: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} },
      { type: 'advisor_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'advisor_result', text: advice } },
      { type: 'text', text: 'done' },
    ] as never,
  })
const advisedTurn = advised('ADVICE_TEXT')
const history = () => [createUserMessage({ content: 'first' }), advisedTurn, createUserMessage({ content: 'test' })]

function ask(
  options: Partial<QueryOptions> = {},
  messages: Parameters<typeof queryModelWithoutStreaming>[0]['messages'] = history(),
) {
  return queryModelWithoutStreaming({
    messages,
    systemPrompt: asSystemPrompt(['SYSTEM']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      model: 'claude-sonnet-4-6',
      querySource: 'repl_main_thread',
      agents: [],
      mcpTools: [],
      hasAppendSystemPrompt: false,
      isNonInteractiveSession: true,
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      ...options,
    },
  })
}

const advisorTools = (i: number) =>
  (requests[i]?.tools ?? []).filter(t => (t as { type?: string }).type === 'advisor_20260301')
const sentBeta = (i: number) =>
  requestBetaHeaders[i]!.includes(ADVISOR_BETA) || JSON.stringify(requests[i]).includes(ADVISOR_BETA)
const sentAdvisorBlocks = (i: number) => JSON.stringify(requests[i]?.messages).includes('ADVICE_TEXT')

afterAll(() => {
  expect(unexpectedIO).toEqual([])
  mock.restore()
})

afterEach(() => {
  requests.length = 0
  requestBetaHeaders.length = 0
  loggedEvents.length = 0
  refusal = undefined
  for (const key of envKeys) delete process.env[key]
  resetAdvisorRefusalsForTesting()
})

test('the advisor tool, beta and history go out with the configured advisor', async () => {
  const result = await ask({ advisorModel: 'opus' })
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(1)
  expect(requests[0]!.tools?.at(-1) as unknown).toEqual({
    type: 'advisor_20260301', name: 'advisor', model: resolveAdvisorModelId('opus'),
  })
  expect(sentBeta(0)).toBe(true)
  expect(sentAdvisorBlocks(0)).toBe(true)
  // The instructions arrive as an attachment from the query loop, never in the system prompt.
  expect(JSON.stringify(requests[0]!.system)).not.toContain('Advisor Tool')
})

test('without an advisor the beta stays and earlier advisor blocks are stripped', async () => {
  await ask()
  expect(advisorTools(0)).toEqual([])
  expect(sentBeta(0)).toBe(true)
  expect(sentAdvisorBlocks(0)).toBe(false)
  expect(JSON.stringify(requests[0]!.messages)).toContain('done')
})

test('only agentic requests and pinned forks carry the advisor', async () => {
  await ask({ advisorModel: 'opus', querySource: 'compact' })
  expect(advisorTools(0)).toEqual([])
  expect(sentAdvisorBlocks(0)).toBe(false)
  await ask({ advisorModel: 'opus', querySource: 'compact', forkAdvisor: true })
  expect(advisorTools(1)).toHaveLength(1)
  await ask({ advisorModel: 'opus', model: 'claude-opus-4-5' })
  expect(advisorTools(2)).toEqual([])
})

test.each([
  ['firstParty', undefined],
  ['bedrock', 'CLAUDE_CODE_USE_BEDROCK'],
  ['vertex', 'CLAUDE_CODE_USE_VERTEX'],
  ['foundry', 'CLAUDE_CODE_USE_FOUNDRY'],
  ['openai', 'CLAUDE_CODE_USE_OPENAI'],
] as const)('provider %s', async (provider, env) => {
  if (env) process.env[env] = '1'
  await ask({ advisorModel: 'opus' })
  const mounted = provider === 'firstParty'
  expect(advisorTools(0)).toHaveLength(mounted ? 1 : 0)
  expect(sentBeta(0)).toBe(mounted)
  expect(sentAdvisorBlocks(0)).toBe(mounted)
  expect(JSON.stringify(requests[0])).not.toContain('Advisor Tool')
  if (!mounted) expect(JSON.stringify(requests[0])).not.toContain('advisor')
})

test('CLAUDE_CODE_DISABLE_ADVISOR_TOOL and CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS keep requests unchanged', async () => {
  process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = '1'
  await ask({ advisorModel: 'opus' })
  delete process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
  await ask({ advisorModel: 'opus' })
  for (const i of [0, 1]) {
    expect(advisorTools(i)).toEqual([])
    expect(sentBeta(i)).toBe(false)
    expect(sentAdvisorBlocks(i)).toBe(false)
  }
})

test('a conversation-scope refusal retries once without the advisor and only tells the conversation', async () => {
  refusal = { status: 400, message: 'the advisor tool is not available for this model', on: 'tool' }
  let refused = 0
  const result = await ask({ advisorModel: 'opus', onAdvisorRefused: () => refused++ })
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(2)
  expect(advisorTools(0)).toHaveLength(1)
  expect(advisorTools(1)).toEqual([])
  expect(sentAdvisorBlocks(1)).toBe(false)
  expect(refused).toBe(1)
  // Nothing latched at the process level: another conversation still asks.
  refusal = undefined
  await ask({ advisorModel: 'opus' })
  expect(advisorTools(2)).toHaveLength(1)
})

test.each([
  ['host', 400, "tools.0: Input tag 'advisor_20260301' found using 'type' does not match any of the expected tags"],
  ['host', 422, "Input tag 'advisor_20260301' is not supported"],
  ['process', 400, 'the advisor tool is not available for this organization'],
] as const)('a %s-scope refusal (%d) turns the advisor off for later requests', async (_scope, status, message) => {
  refusal = { status, message, on: 'tool' }
  await ask({ advisorModel: 'opus' })
  expect(requests).toHaveLength(2)
  expect(advisorTools(1)).toEqual([])
  refusal = undefined
  await ask({ advisorModel: 'opus' })
  expect(advisorTools(2)).toEqual([])
  expect(sentBeta(2)).toBe(false)
})

test('a rejected beta header is retried without it and stays off for the host', async () => {
  refusal = { status: 400, message: `Unexpected value(s) \`${ADVISOR_BETA}\` for the \`anthropic-beta\` header.`, on: 'beta' }
  const result = await ask()
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(2)
  expect(sentBeta(0)).toBe(true)
  expect(sentBeta(1)).toBe(false)
  refusal = undefined
  await ask({ advisorModel: 'opus' })
  expect(sentBeta(2)).toBe(false)
  expect(advisorTools(2)).toEqual([])
})

test('an incompatible pairing is shown, not retried', async () => {
  refusal = { status: 400, message: 'claude-sonnet-4-6 cannot be used as an advisor when the request model is claude-opus-5', on: 'tool' }
  let refused = 0
  const result = await ask({ advisorModel: 'sonnet', onAdvisorRefused: () => refused++ })
  expect(requests).toHaveLength(1)
  expect(refused).toBe(0)
  expect(result.isApiErrorMessage).toBe(true)
  expect(JSON.stringify(result.message.content)).toContain(
    'The configured advisor model is not compatible with this request model',
  )
})

test('the provider switching to OpenAI mid-session drops the advisor and its history', async () => {
  await ask({ advisorModel: 'opus' })
  expect(advisorTools(0)).toHaveLength(1)
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  await ask({ advisorModel: 'opus' })
  expect(advisorTools(1)).toEqual([])
  expect(sentBeta(1)).toBe(false)
  expect(sentAdvisorBlocks(1)).toBe(false)
  expect(JSON.stringify(requests[1])).not.toContain('advisor')
})

const stripEvents = () =>
  loggedEvents.filter(([name]) => name === 'tengu_advisor_strip_retry').map(([, m]) => m)

test('an unprocessable advisor result is retried once without advisor blocks and recorded', async () => {
  refusal = { status: 400, message: 'Advisor tool result content could not be processed', on: 'blocks' }
  let recorded = 0
  const result = await ask({ advisorModel: 'opus', onAdvisorBlocksStripped: () => recorded++ })
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(2)
  expect(sentAdvisorBlocks(0)).toBe(true)
  expect(sentAdvisorBlocks(1)).toBe(false)
  // The advisor itself stays: only the history it could not read goes.
  expect(advisorTools(1)).toHaveLength(1)
  expect(JSON.stringify(requests[1]!.messages)).toContain('done')
  expect(recorded).toBe(1)
  expect(stripEvents()).toEqual([{
    query_source: 'repl_main_thread', strip_recorded: true,
    stripped_message_count: 1, thinking_also_stripped: false,
  }])
})

test('with nothing to remove the request is retried as sent and not recorded', async () => {
  refusal = { status: 400, message: 'tool_use_id srvtoolu_9 found in advisor_tool_result blocks', on: 'tool' }
  let recorded = 0
  const result = await ask(
    { advisorModel: 'opus', onAdvisorBlocksStripped: () => recorded++ },
    [createUserMessage({ content: 'test' })],
  )
  // The tool-wide fake refuses again; the retry is not repeated.
  expect(requests).toHaveLength(2)
  expect(result.isApiErrorMessage).toBe(true)
  expect(recorded).toBe(0)
  expect(stripEvents()).toMatchObject([{ strip_recorded: false, stripped_message_count: 0 }])
})

test('an advisor_stripped attachment keeps earlier advisor blocks out of later requests', async () => {
  await ask({ advisorModel: 'opus' }, [
    createUserMessage({ content: 'first' }),
    advisedTurn,
    createAttachmentMessage({ type: 'advisor_stripped' }),
    createUserMessage({ content: 'second' }),
    advised('LATER_ADVICE'),
    createUserMessage({ content: 'test' }),
  ])
  expect(sentAdvisorBlocks(0)).toBe(false)
  expect(JSON.stringify(requests[0]!.messages)).toContain('LATER_ADVICE')
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('advisor_stripped')
})
}
