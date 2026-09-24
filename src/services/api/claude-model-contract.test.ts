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

test.each([false, true])(
  'Mods deferral changes initial schemas, ToolSearch candidates and discovered schema loading (delta=%s)',
  async deltaEnabled => {
    const deltaGate = spyOn(
      growthbook,
      'getFeatureValue_CACHED_MAY_BE_STALE',
    ).mockImplementation((key, fallback) =>
      key === 'tengu_glacier_2xr'
        ? (deltaEnabled as typeof fallback)
        : fallback,
    )
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { z } = await import('zod/v4')
    const { createModsRuntime } = await import('../mods/runtime.js')
    const { ToolSearchTool } =
      await import('../../tools/ToolSearchTool/ToolSearchTool.js')
    const { clearToolSchemaCache } =
      await import('../../utils/toolSchemaCache.js')
    const root = await mkdtemp(join(tmpdir(), 'mods-deferral-wire-'))
    const entry = join(root, 'register.ts')
    const diagnostics: string[] = []
    const runtime = createModsRuntime({
      onDiagnostic: event => diagnostics.push(event.message),
    })
    const previous = process.env.ENABLE_TOOL_SEARCH
    process.env.ENABLE_TOOL_SEARCH = 'true'
    clearToolSchemaCache()
    await writeFile(
      entry,
      `export function register(on) {
    let flipped = false;
    on('tool.describe', ($, e) => ({description:'quartz '+e.tool, isDeferred:e.tool === 'ToolSearch' || (flipped ? e.tool === 'mcp__corp__lookup' : e.tool === 'LocalLookup')}));
    on('tool.call', {tool:'Invalidate'}, async ($) => { flipped = !flipped; await $.ui.invalidate('tool.describe'); return {result:'invalidated'}; });
  }`,
    )
    await runtime.reconcile([
      {
        name: 'placement',
        storageId: 'placement@inline',
        pluginRoot: root,
        entrypoints: [entry],
        tier: 'user',
      },
    ])
    const snapshot = runtime.capture()
    const local = {
      name: 'LocalLookup',
      inputSchema: z.object({ key: z.string() }),
      async prompt() {
        return 'local lookup'
      },
    } as unknown as import('../../Tool.js').Tool
    const pinned = { ...local, name: 'mcp__corp__lookup', isMcp: true }
    const tools = [local, pinned, ToolSearchTool]
    const messages: import('../../types/message.js').Message[] = [
      createUserMessage({ content: 'test' }),
    ]
    if (deltaEnabled) {
      const { createAttachmentMessage } =
        await import('../../utils/attachments.js')
      messages.push(
        createAttachmentMessage({
          type: 'deferred_tools_delta',
          addedNames: [pinned.name],
          addedLines: [pinned.name],
          removedNames: [],
        }),
      )
    }
    const run = async (model = 'claude-sonnet-5') => {
      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools,
        signal: new AbortController().signal,
        options: {
          model,
          querySource: 'repl_main_thread',
          agents: [],
          mcpTools: [pinned],
          hasAppendSystemPrompt: false,
          isNonInteractiveSession: true,
          enablePromptCaching: false,
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
          modsSnapshot: snapshot,
        },
      })
      expect(result.message.content).toMatchObject([
        { type: 'text', text: 'OK' },
      ])
      return requests.at(-1)!
    }
    try {
      const initial = await run()
      expect(
        initial.tools?.map(tool => ('name' in tool ? tool.name : undefined)),
      ).toEqual(['mcp__corp__lookup', 'ToolSearch'])
      expect(initial.tools?.every(tool => !('defer_loading' in tool))).toBe(
        true,
      )
      expect(JSON.stringify(initial.messages)).toContain(
        deltaEnabled
          ? 'The following deferred tools are now available via ToolSearch:\\nLocalLookup'
          : '<available-deferred-tools>\\nLocalLookup\\n</available-deferred-tools>',
      )
      expect(JSON.stringify(initial.messages)).not.toContain(pinned.name)
      if (deltaEnabled)
        expect((messages[1] as any).attachment.addedNames).toEqual([
          pinned.name,
        ])
      const context = {
        options: {
          tools,
          agentDefinitions: { activeAgents: [] },
          mainLoopModel: 'claude-sonnet-5',
          mcpClients: [],
          isNonInteractiveSession: true,
        },
        getAppState: () => ({
          toolPermissionContext: getEmptyToolPermissionContext(),
          mcp: { clients: [] },
          sessionHooks: new Map(),
        }),
        messages: [],
        setAppState: () => {},
        setInProgressToolUseIDs: () => {},
        // toolExecution clears the invocation snapshot before entering Tool.call.
        mods: runtime,
        abortController: new AbortController(),
      } as unknown as import('../../Tool.js').ToolUseContext
      const { data } = await ToolSearchTool.call(
        { query: 'quartz', max_results: 5 },
        context,
        async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      )
      expect(data).toMatchObject({
        matches: ['LocalLookup'],
        total_deferred_tools: 1,
      })
      const { runToolUse } = await import('../tools/toolExecution.js')
      const { createAssistantMessage } = await import('../../utils/messages.js')
      const searchUse = {
        type: 'tool_use' as const,
        caller: { type: 'direct' as const },
        id: 'search-1',
        name: 'ToolSearch',
        input: { query: 'quartz', max_results: 5 },
      }
      const assistant = createAssistantMessage({ content: [searchUse] })
      const updates = await Array.fromAsync(
        runToolUse(
          searchUse,
          assistant,
          async () => ({ behavior: 'allow' }),
          context,
        ),
      )
      const results = updates.flatMap(update =>
        update.message?.type === 'user' ? [update.message] : [],
      )
      expect(JSON.stringify(results)).toContain('"tool_name":"LocalLookup"')
      expect(JSON.stringify(results)).not.toContain(
        '"tool_name":"mcp__corp__lookup"',
      )
      messages.push(assistant, ...results)
      const loaded = await run()
      expect(
        loaded.tools?.map(tool => ('name' in tool ? tool.name : undefined)),
      ).toEqual(['LocalLookup', 'mcp__corp__lookup', 'ToolSearch'])
      expect(loaded.tools?.[0]).toMatchObject({
        description: 'quartz LocalLookup',
        defer_loading: true,
        input_schema: { required: ['key'] },
      })
      const unsupported = await run('claude-haiku-4-5')
      expect(
        unsupported.tools?.map(tool =>
          'name' in tool ? tool.name : undefined,
        ),
      ).toEqual(['LocalLookup', 'mcp__corp__lookup'])
      expect(unsupported.tools?.every(tool => !('defer_loading' in tool))).toBe(
        true,
      )
      expect(JSON.stringify(unsupported.messages)).not.toContain(
        'available via ToolSearch',
      )
      await snapshot.dispatch(
        'tool.call',
        { tool: 'Invalidate' },
        async () => ({ result: 'core' }),
      )
      messages.splice(1)
      const flipped = await run()
      expect(
        flipped.tools?.map(tool => ('name' in tool ? tool.name : undefined)),
      ).toEqual(['LocalLookup', 'ToolSearch'])
      expect(flipped.tools?.every(tool => !('defer_loading' in tool))).toBe(
        true,
      )
      const refreshed = await ToolSearchTool.call(
        { query: 'quartz', max_results: 5 },
        context,
        async (_tool, input) => ({ behavior: 'allow', updatedInput: input }),
      )
      expect(refreshed.data).toMatchObject({
        matches: ['mcp__corp__lookup'],
        total_deferred_tools: 1,
      })
      expect(diagnostics).toEqual([])
    } finally {
      snapshot.release()
      await runtime.dispose()
      clearToolSchemaCache()
      if (previous === undefined) delete process.env.ENABLE_TOOL_SEARCH
      else process.env.ENABLE_TOOL_SEARCH = previous
      await rm(root, { recursive: true, force: true })
      deltaGate.mockImplementation((_key, fallback) => fallback)
    }
  },
)

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

test('prompt.attachment projects retained and generated deferred deltas at the SDK boundary', async () => {
  const deltaGate = spyOn(
    growthbook,
    'getFeatureValue_CACHED_MAY_BE_STALE',
  ).mockImplementation((key, fallback) =>
    key === 'tengu_glacier_2xr' ? (true as typeof fallback) : fallback,
  )
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { z } = await import('zod/v4')
  const { createModsRuntime } = await import('../mods/runtime.js')
  const { ToolSearchTool } =
    await import('../../tools/ToolSearchTool/ToolSearchTool.js')
  const { clearToolSchemaCache } =
    await import('../../utils/toolSchemaCache.js')
  const { createAttachmentMessage } = await import('../../utils/attachments.js')
  const root = await mkdtemp(join(tmpdir(), 'mods-attachment-wire-'))
  const entry = join(root, 'register.ts')
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
  })
  const previous = process.env.ENABLE_TOOL_SEARCH
  process.env.ENABLE_TOOL_SEARCH = 'true'
  clearToolSchemaCache()
  try {
    await writeFile(
      entry,
      `let calls = 0;
export function register(on) {
  on('tool.describe', ($, e) => ({description: e.tool, isDeferred: e.tool === 'DeferredLookup'}));
  on('prompt.attachment', ($, e) => ({text: 'PROJECTED_' + (++calls) + ':' + e.text}));
  on('tool.call', {tool: 'AttachmentCalls'}, () => ({result: calls}));
}`,
    )
    await runtime.reconcile([
      {
        name: 'attachment-wire',
        storageId: 'attachment-wire@inline',
        pluginRoot: root,
        entrypoints: [entry],
        tier: 'user',
      },
    ])
    const snapshot = runtime.capture()
    const deferred = {
      name: 'DeferredLookup',
      inputSchema: z.object({ key: z.string() }),
      async prompt() {
        return 'deferred lookup'
      },
    } as unknown as import('../../Tool.js').Tool
    const tools = [deferred, ToolSearchTool]
    const retainedDelta = createAttachmentMessage({
      type: 'deferred_tools_delta',
      addedNames: [deferred.name],
      addedLines: ['STALE_RETAINED_LINE'],
      removedNames: [],
    })
    const run = async (messages: import('../../types/message.js').Message[]) => {
      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt: asSystemPrompt([]),
        thinkingConfig: { type: 'disabled' },
        tools,
        signal: new AbortController().signal,
        options: {
          model: 'claude-sonnet-5',
          querySource: 'repl_main_thread',
          agents: [],
          mcpTools: [],
          hasAppendSystemPrompt: false,
          isNonInteractiveSession: true,
          enablePromptCaching: false,
          getToolPermissionContext: async () =>
            getEmptyToolPermissionContext(),
          modsSnapshot: snapshot,
        },
      })
      expect(result.message.content).toMatchObject([
        { type: 'text', text: 'OK' },
      ])
      return requests.at(-1)!
    }
    try {
      const retainedMessages = [
        createUserMessage({ content: 'existing delta' }),
        retainedDelta,
      ]
      const existing = await run(retainedMessages)
      expect(JSON.stringify(existing.messages)).toContain('PROJECTED_1:')
      expect(JSON.stringify(existing.messages)).toContain('DeferredLookup')
      expect(JSON.stringify(existing.messages)).not.toContain(
        'STALE_RETAINED_LINE',
      )
      expect(retainedDelta.attachment).toMatchObject({
        type: 'deferred_tools_delta',
        addedLines: ['STALE_RETAINED_LINE'],
      })

      const freshMessages = [createUserMessage({ content: 'new delta' })]
      const generated = await run(freshMessages)
      expect(JSON.stringify(generated.messages)).toContain('PROJECTED_2:')
      expect(JSON.stringify(generated.messages)).toContain('DeferredLookup')
      expect(freshMessages).toHaveLength(1)
      expect(
        await snapshot.dispatch(
          'tool.call',
          { tool: 'AttachmentCalls' },
          async () => ({ result: 'unhandled' }),
        ),
      ).toEqual({ result: 2 })
      expect(diagnostics).toEqual([])
    } finally {
      snapshot.release()
    }
  } finally {
    await runtime.dispose()
    clearToolSchemaCache()
    if (previous === undefined) delete process.env.ENABLE_TOOL_SEARCH
    else process.env.ENABLE_TOOL_SEARCH = previous
    await rm(root, { recursive: true, force: true })
    deltaGate.mockImplementation((_key, fallback) => fallback)
  }
})
