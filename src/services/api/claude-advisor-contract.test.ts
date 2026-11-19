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
  'CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_MAX_RETRIES',
  'ANTHROPIC_BETAS',
] as const
for (const key of envKeys) delete process.env[key]
// The advisor is off without it; every test starts with it on.
const SWITCH = 'CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL'
beforeEach(() => {
  process.env[SWITCH] = '1'
})

const ADVISOR_BETA = 'advisor-tool-2026-03-01'
const TOOL_CHANGES_BETA = 'mid-conversation-tool-changes-2026-07-01'
const SYSTEM_BETA = 'mid-conversation-system-2026-04-07'
const requests: MessageCreateParams[] = []
const requestBetaHeaders: string[] = []
// Refuse requests that carry the advisor tool (or, for 'beta', the header).
// 'blocks' refuses requests whose history still carries ADVICE_TEXT.
// 'toolChanges' refuses requests with the tool-change beta, 'system' ones with a system turn,
// 'always' every request.
let refusal:
  | {
      status: number
      message: string
      on: 'tool' | 'beta' | 'blocks' | 'toolChanges' | 'system' | 'always'
      /** The error type in the body; invalid_request_error when absent. */
      type?: string
    }
  | undefined
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
      (refusal.on === 'always' ||
      (refusal.on === 'tool'
        ? hasAdvisorTool(request)
        : refusal.on === 'beta'
          ? beta.includes(ADVISOR_BETA)
          : refusal.on === 'toolChanges'
            ? beta.includes(TOOL_CHANGES_BETA)
            : refusal.on === 'system'
              ? request.messages.some(m => (m.role as string) === 'system')
              : JSON.stringify(request.messages).includes('ADVICE_TEXT')))
    ) {
      return Response.json(
        { type: 'error', error: { type: refusal.type ?? 'invalid_request_error', message: refusal.message } },
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
const { resetToolChangeLatchesForTesting } = await import('../../utils/advisorToolChanges.js')
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

const advisorTools = (i: number): unknown[] =>
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
  resetToolChangeLatchesForTesting()
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
  // Whatever the main model.
  await ask({ advisorModel: 'opus', model: 'claude-opus-4-5' })
  expect(advisorTools(2)).toHaveLength(1)
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

test('a pairing the server refuses is retried without the advisor, for the local advisor to answer', async () => {
  refusal = { status: 400, message: 'claude-sonnet-4-6 cannot be used as an advisor when the request model is claude-opus-5', on: 'tool' }
  let refused = 0
  const result = await ask({ advisorModel: 'sonnet', onAdvisorRefused: () => refused++ })
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(2)
  expect(advisorTools(0)).toHaveLength(1)
  expect(advisorTools(1)).toEqual([])
  expect(refused).toBe(1)
  // Only this conversation: another one still asks the server.
  refusal = undefined
  await ask({ advisorModel: 'opus' })
  expect(advisorTools(2)).toHaveLength(1)
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

test('with nothing to remove the request is retried as sent, then without the advisor, and not recorded', async () => {
  refusal = { status: 400, message: 'tool_use_id srvtoolu_9 found in advisor_tool_result blocks', on: 'tool' }
  let recorded = 0
  let refused = 0
  const result = await ask(
    {
      advisorModel: 'opus',
      onAdvisorBlocksStripped: () => recorded++,
      onAdvisorRefused: () => refused++,
    },
    [createUserMessage({ content: 'test' })],
  )
  // The tool-wide fake refuses the retry too; the strip is not repeated. What
  // is left is an error this client cannot attribute, so the last try leaves
  // the advisor out and the conversation goes on with the local one.
  expect(requests).toHaveLength(3)
  expect(advisorTools(1)).toHaveLength(1)
  expect(advisorTools(2)).toEqual([])
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(recorded).toBe(0)
  expect(refused).toBe(1)
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

// Mid-conversation tool changes (beta mid-conversation-tool-changes-2026-07-01).
const TOOL_CHANGE_MODEL = 'claude-sonnet-5-5'
const OTHER_TOOL = { name: 'other_tool', description: 'x', input_schema: { type: 'object' } }
const opus = () => resolveAdvisorModelId('opus')
const toolChangeOptions = (
  toolChanges: Record<string, unknown>,
  advisorActive: boolean,
  extra: Partial<QueryOptions> = {},
): Partial<QueryOptions> => ({
  model: TOOL_CHANGE_MODEL,
  advisorModel: 'opus',
  advisorDeferred: true,
  advisorActive,
  toolChanges,
  extraToolSchemas: [OTHER_TOOL as never],
  ...extra,
})
const toolChange = (op: 'add' | 'remove') =>
  createAttachmentMessage(
    op === 'add'
      ? { type: 'advisor_tool', available: true, model: opus(), toolChange: 'add' }
      : { type: 'advisor_tool', available: false, model: opus(), toolChange: 'remove' },
  )
const systemTurns = (i: number) =>
  requests[i]!.messages.filter(m => (m.role as string) === 'system') as unknown as {
    content: { type: string; text?: string; tool?: unknown }[]
  }[]
const sentToolChangeBetas = (i: number) => [
  requestBetaHeaders[i]!.includes(TOOL_CHANGES_BETA),
  requestBetaHeaders[i]!.includes(SYSTEM_BETA),
]

test('an advisor that is off stays declared deferred, with no system turn or instructions', async () => {
  await ask(toolChangeOptions({}, false))
  expect(advisorTools(0)).toEqual([
    { type: 'advisor_20260301', name: 'advisor', model: opus(), defer_loading: true },
  ])
  expect(sentToolChangeBetas(0)).toEqual([true, true])
  expect(systemTurns(0)).toEqual([])
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('Advisor Tool')
  // Without another non-deferred tool there is nothing to defer against.
  await ask(toolChangeOptions({}, false, { extraToolSchemas: [] }))
  expect(advisorTools(1)).toEqual([])
})

test('turning the advisor on and off mid-conversation keeps the tools prefix', async () => {
  const sticky = {}
  await ask(toolChangeOptions(sticky, false))
  const on = [...history(), toolChange('add')]
  await ask(toolChangeOptions(sticky, true), on)
  await ask(toolChangeOptions(sticky, false), [
    ...on,
    createAssistantMessage({ content: [{ type: 'text', text: 'reply' }] as never }),
    createUserMessage({ content: 'more' }),
    toolChange('remove'),
  ])
  expect(requests).toHaveLength(3)
  for (const i of [1, 2]) {
    expect(requests[i]!.tools).toEqual(requests[0]!.tools)
    expect(sentToolChangeBetas(i)).toEqual([true, true])
  }
  // On: one system turn right after the user turn it was attached to.
  expect(systemTurns(1)).toHaveLength(1)
  expect(requests[1]!.messages.at(-1)!.role as string).toBe('system')
  expect(requests[1]!.messages.at(-2)!.role).toBe('user')
  const [text, addition] = systemTurns(1)[0]!.content
  expect(text!.type).toBe('text')
  expect(text!.text).toStartWith('# Advisor Tool')
  expect(addition).toMatchObject({ type: 'tool_addition', tool: { type: 'tool_reference', name: 'advisor' } })
  expect(JSON.stringify(requests[1]!.messages.filter(m => m.role === 'user'))).not.toContain('Advisor Tool')
  // Off: the addition stays where it was, so request 2 is a prefix of request 3.
  const uncached = (i: number) =>
    JSON.parse(JSON.stringify(requests[i]!.messages).replaceAll(',"cache_control":{"type":"ephemeral"}', ''))
  expect(uncached(2).slice(0, requests[1]!.messages.length)).toEqual(uncached(1))
  expect(requests[2]!.messages.map(m => m.role as string)).toEqual([
    'user', 'assistant', 'user', 'system', 'assistant', 'user', 'system',
  ])
  expect(systemTurns(2).map(t => t.content[1]!.type)).toEqual(['tool_addition', 'tool_removal'])
  expect(systemTurns(2)[1]!.content[0]!.text).toContain('no longer available')
})

test('a rejected tool-change beta falls back to the inline entry and reminders, sticky', async () => {
  refusal = {
    status: 400,
    message: `Unexpected value(s) \`${TOOL_CHANGES_BETA}\` for the \`anthropic-beta\` header.`,
    on: 'toolChanges',
  }
  const sticky: Record<string, unknown> = {}
  let fellBack = 0
  const result = await ask(
    toolChangeOptions(sticky, true, { onToolChangeFallback: () => fellBack++ }),
    [...history(), toolChange('add')],
  )
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(2)
  expect(sentToolChangeBetas(1)).toEqual([false, false])
  expect(advisorTools(1)).toEqual([{ type: 'advisor_20260301', name: 'advisor', model: opus() }])
  expect(systemTurns(1)).toEqual([])
  expect(JSON.stringify(requests[1]!.messages)).toContain('<system-reminder>\\n# Advisor Tool')
  expect(sentBeta(1)).toBe(true)
  expect(fellBack).toBe(1)
  expect(sticky.rejected).toBe(true)
  // Later requests of the conversation stay without it; an inactive entry is left out.
  refusal = undefined
  await ask(toolChangeOptions(sticky, false))
  expect(sentToolChangeBetas(2)).toEqual([false, false])
  expect(advisorTools(2)).toEqual([])
})

test('a rejected system turn retries without system turns and keeps them off', async () => {
  refusal = { status: 400, message: "messages.3.role: Input should be 'user' or 'assistant'", on: 'system' }
  const sticky: Record<string, unknown> = {}
  await ask(toolChangeOptions(sticky, true), [...history(), toolChange('add')])
  expect(requests).toHaveLength(2)
  expect(systemTurns(0)).toHaveLength(1)
  expect(systemTurns(1)).toEqual([])
  expect(sentToolChangeBetas(1)).toEqual([false, false])
  expect(sticky.systemRejected).toBe(true)
  expect(loggedEvents.some(([name]) => name === 'tengu_mid_conv_system_fallback_retry')).toBe(true)
})

test('requests without conversation state or a capable model do not send the betas', async () => {
  await ask({ model: TOOL_CHANGE_MODEL, advisorModel: 'opus' })
  await ask({ advisorModel: 'opus', toolChanges: {} })
  expect(sentToolChangeBetas(0)).toEqual([false, false])
  expect(sentToolChangeBetas(1)).toEqual([false, false])
})

// The local advisor: `advisor` is a client-executed tool that sends its own request.
const LOCAL_ADVISOR = 'Opus 5.5'
const { AdvisorTool } = await import('../../tools/AdvisorTool/AdvisorTool.js')
function consult(overrides: Record<string, unknown> = {}) {
  const context = {
    options: {
      tools: [], thinkingConfig: { type: 'disabled' }, isNonInteractiveSession: true,
      mainLoopModel: 'claude-sonnet-4-6',
    },
    abortController: new AbortController(),
    getAppState: () => ({ advisorModel: LOCAL_ADVISOR }),
    messages: [
      createUserMessage({ content: 'fix the login bug' }),
      createAssistantMessage({
        content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/src/login.ts' } }] as never,
      }),
      createUserMessage({
        content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'export function login() {}' }],
      }),
    ],
    // The reply being streamed: it is not in `messages` yet.
    getResponseMessages: () => [
      createAssistantMessage({ content: 'Should I use A or B?' }),
      createAssistantMessage({
        content: [{ type: 'tool_use', id: 'toolu_advisor', name: 'advisor', input: {} }] as never,
      }),
    ],
    ...overrides,
  }
  return AdvisorTool.call({}, context as never)
}

test('any main model and any advisor go out as the server-side advisor first', async () => {
  await ask({ model: 'Grok-4.7', advisorModel: 'Opus 5.5' })
  expect(advisorTools(0)).toEqual([{ type: 'advisor_20260301', name: 'advisor', model: 'Opus 5.5' }])
  expect(sentBeta(0)).toBe(true)
  expect(sentAdvisorBlocks(0)).toBe(true)
  await ask({ model: 'claude-fable-5-1', advisorModel: 'claude-haiku-4-5' })
  expect(advisorTools(1)).toHaveLength(1)
})

test('local advisor: after Anthropic refuses the server-side advisor the local tool answers', async () => {
  refusal = { status: 400, message: 'the advisor tool is not available for this organization', on: 'tool' }
  let refused = 0
  const result = await ask({ advisorModel: 'opus', onAdvisorRefused: () => refused++ })
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(2)
  expect(advisorTools(0)).toHaveLength(1)
  expect(advisorTools(1)).toEqual([])
  expect(refused).toBe(1)
  // Later requests leave the server-side advisor out; the local one takes the setting.
  await ask({ advisorModel: 'opus' })
  expect(advisorTools(2)).toEqual([])
  expect(sentBeta(2)).toBe(false)
  const advice = await consult({ getAppState: () => ({ advisorModel: 'opus' }) })
  expect(advice.data).toEqual({ advice: 'OK', model: resolveAdvisorModelId('opus') })
  expect(requests[3]!.model).toBe(resolveAdvisorModelId('opus'))
  expect(sentBeta(3)).toBe(false)
})

// What a gateway answers when it cannot read the advisor entry.
const GATEWAY_ERROR = 'Failed to deserialize the JSON body into the target type'

test.each([400, 422])('local advisor: a %d in other words than Anthropic\'s is retried without the server-side advisor', async status => {
  refusal = { status, message: GATEWAY_ERROR, on: 'tool' }
  let refused = 0
  const result = await ask({ advisorModel: 'opus', onAdvisorRefused: () => refused++ })
  expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
  expect(requests).toHaveLength(2)
  expect(advisorTools(0)).toHaveLength(1)
  expect(advisorTools(1)).toEqual([])
  expect(sentAdvisorBlocks(1)).toBe(false)
  // The answered retry is what tells the conversation; nothing is latched beyond it.
  expect(refused).toBe(1)
  refusal = undefined
  await ask({ advisorModel: 'opus' })
  expect(advisorTools(2)).toHaveLength(1)
})

test('local advisor: the retry without the server-side advisor offers the local tool in its place', async () => {
  const localTools = (i: number) =>
    (requests[i]?.tools ?? []).filter(t => (t as { name?: string; type?: string }).name === 'advisor' && (t as { type?: string }).type === undefined)
  for (const message of [GATEWAY_ERROR, 'the advisor tool is not available for this organization']) {
    requests.length = 0
    resetAdvisorRefusalsForTesting()
    refusal = { status: 400, message, on: 'tool' }
    const result = await ask({ advisorModel: 'opus', advisorRetryTools: [AdvisorTool] })
    expect(result.message.content).toMatchObject([{ type: 'text', text: 'OK' }])
    expect(requests).toHaveLength(2)
    expect(localTools(0)).toEqual([])
    expect(advisorTools(1)).toEqual([])
    expect(localTools(1)).toHaveLength(1)
  }
})

test('local advisor: an error the retry does not cure is shown and the server-side advisor stays', async () => {
  refusal = { status: 400, message: 'messages.2: unexpected field', on: 'always' }
  let refused = 0
  const result = await ask({ advisorModel: 'opus', onAdvisorRefused: () => refused++ })
  expect(requests).toHaveLength(2)
  expect(advisorTools(1)).toEqual([])
  expect(refused).toBe(0)
  expect(result.isApiErrorMessage).toBe(true)
  expect(JSON.stringify(result.message.content)).toContain('unexpected field')
  refusal = undefined
  await ask({ advisorModel: 'opus' })
  expect(advisorTools(2)).toHaveLength(1)
})

test.each([
  ['a prompt that is too long', { status: 400, message: 'prompt is too long: 250000 tokens > 200000 maximum' }],
  ['a billing error', { status: 400, message: 'Your credit balance is too low', type: 'billing_error' }],
  ['a server error', { status: 500, message: GATEWAY_ERROR }],
  ['a request without the server-side advisor', { status: 400, message: GATEWAY_ERROR, advisorModel: undefined }],
] as const)('local advisor: %s is not retried without the advisor', async (_name, { status, message, ...rest }) => {
  process.env.CLAUDE_CODE_MAX_RETRIES = '0'
  refusal = { status, message, on: 'always', ...('type' in rest ? { type: rest.type } : {}) }
  let refused = 0
  const result = await ask({
    advisorModel: 'advisorModel' in rest ? rest.advisorModel : 'opus',
    onAdvisorRefused: () => refused++,
  })
  expect(requests).toHaveLength(1)
  expect(refused).toBe(0)
  expect(result.isApiErrorMessage).toBe(true)
})

test('local advisor: the tool sends the conversation to the advisor model and returns its advice', async () => {
  const result = await consult()
  expect(result.data).toEqual({ advice: 'OK', model: LOCAL_ADVISOR })
  expect(AdvisorTool.mapToolResultToToolResultBlockParam(result.data, 'toolu_advisor')).toEqual({
    type: 'tool_result', tool_use_id: 'toolu_advisor', content: 'OK',
  })
  expect(requests).toHaveLength(1)
  const request = requests[0]!
  expect(request.model).toBe(LOCAL_ADVISOR)
  expect(request.tools ?? []).toEqual([])
  expect(sentBeta(0)).toBe(false)
  expect(JSON.stringify(request.system)).toContain('You are the advisor')
  expect(request.messages).toHaveLength(1)
  expect(request.messages[0]!.role).toBe('user')
  const sent = JSON.stringify(request.messages)
  for (const part of [
    'fix the login bug',
    '<tool_call name=\\"Read\\">',
    'export function login() {}',
    'Should I use A or B?',
  ]) {
    expect(sent).toContain(part)
  }
  // The call being answered is not part of what the advisor reviews.
  expect(sent).not.toContain('<tool_call name=\\"advisor\\">')
})

test('local advisor: a failed advisor request becomes a tool error that names the model', async () => {
  refusal = { status: 400, message: 'unknown model', on: 'always' }
  await expect(consult()).rejects.toThrow(/The advisor model Opus 5\.5 could not answer: .*unknown model/s)
  expect(requests).toHaveLength(1)
})

test('local advisor: its request is retried at most twice', async () => {
  refusal = { status: 503, message: 'model unavailable', on: 'always' }
  await expect(consult()).rejects.toThrow(/The advisor model Opus 5\.5 could not answer: .*model unavailable/s)
  expect(requests).toHaveLength(3)
  // A lower CLAUDE_CODE_MAX_RETRIES still applies.
  requests.length = 0
  process.env.CLAUDE_CODE_MAX_RETRIES = '0'
  await expect(consult()).rejects.toThrow(/could not answer/)
  expect(requests).toHaveLength(1)
})

test('local advisor: no request goes out without an advisor model, in a fork, or with the switch off', async () => {
  await expect(consult({ getAppState: () => ({}) })).rejects.toThrow('No advisor model is set')
  await expect(consult({ advisorPin: {} })).rejects.toThrow('not available to forked agents')
  delete process.env[SWITCH]
  await expect(consult()).rejects.toThrow('No advisor model is set')
  expect(requests).toHaveLength(0)
})

test('without the switch nothing about the advisor goes out', async () => {
  delete process.env[SWITCH]
  await ask({ advisorModel: 'opus' })
  await ask(toolChangeOptions({}, true))
  // The retired local switch turns nothing on.
  process.env.CLAUDE_CODE_ENABLE_LOCAL_ADVISOR_TOOL = '1'
  await ask({ advisorModel: 'opus' })
  for (const i of [0, 1, 2]) {
    expect(advisorTools(i)).toEqual([])
    expect(sentBeta(i)).toBe(false)
    expect(sentAdvisorBlocks(i)).toBe(false)
    expect(sentToolChangeBetas(i)).toEqual([false, false])
  }
})
}
