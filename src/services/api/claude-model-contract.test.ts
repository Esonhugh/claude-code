import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { QueryParams } from '../../query.js'
import type { ModSessionUsage } from '../mods/sessionUsage.js'

// Bun module mocks outlive mock.restore(). Keep the SDK mocks, non-test context
// rendering, and all credential/network stubs in a private child process.
if (process.env.CLAUDE_MODEL_CONTRACT_CHILD !== import.meta.path) {
  test('offline model contracts in an isolated process', async () => {
    const { mkdir, mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'claude-model-contract-'))
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
          CLAUDE_MODEL_CONTRACT_CHILD: import.meta.path,
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
const tokenRequests: Record<string, unknown>[] = []
let rejectIncompatibleEffort = false
let streamNotFound = false
const client = new Anthropic({
  apiKey: 'test-only',
  maxRetries: 0,
  timeout: 600_000,
  fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as MessageCreateParams
    if (String(_url).includes('/count_tokens')) {
      tokenRequests.push(request as unknown as Record<string, unknown>)
      return Response.json({input_tokens:123})
    }
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
spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE').mockImplementation(
  (_key, fallback) => fallback,
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

const { queryModelWithoutStreaming, queryModelWithStreaming, queryWithModel, queryHaiku, verifyApiKey } =
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
  expect(unexpectedIO).toEqual([])
  mock.restore()
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

afterEach(() => {
  requests.length = 0
  tokenRequests.length = 0
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
      expect(unexpectedIO).toEqual([])
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

test('Mods prompt.context reaches SDK messages in order, caches, invalidates and refreshes after compaction', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomUUID } = await import('node:crypto')
  const { query: runQuery } = await import('../../query.js')
  const { createModsRuntime } = await import('../mods/runtime.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
  const { createCompactBoundaryMessage } = await import('../../utils/messages.js')
  const { registerHookCallbacks, resetStateForTests } = await import('../../bootstrap/state.js')
  const { createCacheSafeParams, getLastCacheSafeParams, saveCacheSafeParams, runForkedAgent } = await import('../../utils/forkedAgent.js')
  const { registerPostSamplingHook, clearPostSamplingHooks } = await import('../../utils/hooks/postSamplingHooks.js')
  const sampled: import('../../utils/forkedAgent.js').CacheSafeParams[] = []
  registerPostSamplingHook(context => { sampled.push(createCacheSafeParams(context)) })
  const root = await mkdtemp(join(tmpdir(), 'mods-context-wire-'))
  const entry = join(root, 'register.ts')
  const contextFile = join(root, 'context.txt')
  const diagnostics: string[] = []
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event.message),
  })
  const originalNodeEnv = process.env.NODE_ENV
  resetStateForTests()
  try {
    await writeFile(entry, `export function register(on) {
      let runs = 0;
      on('prompt.context', ($, e) => {
        runs++;
        return {blocks:[
          {name:'9', text:'wire:'+e.blocks.find(b => b.name === 'claudeMd').text+':'+runs},
          {name:'2', text:'tail:'+runs},
        ]};
      });
      on('tool.call', {tool:'ContextRuns'}, () => ({result:runs}));
      on('tool.call', {tool:'InvalidateContext'}, async ($) => {
        await $.ui.invalidate('prompt.context'); return {result:runs};
      });
    }`)
    await writeFile(contextFile, 'first')
    await runtime.reconcile([{
      name: 'context-wire', storageId: 'context-wire@inline',
      pluginRoot: root, entrypoints: [entry], tier: 'user',
    }])
    expect(diagnostics).toEqual([])
    expect(runtime.hasHooks('prompt.context')).toBe(true)

    let appState = getDefaultAppState()
    const toolUseContext: import('../../utils/processUserInput/processUserInput.js').ProcessUserInputContext = {
      options: {
        commands: [], debug: false, mainLoopModel: 'claude-sonnet-5',
        tools: [], verbose: false, thinkingConfig: { type: 'disabled' },
        mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
        ideInstallationStatus: null, theme: 'dark',
      },
      abortController: new AbortController(),
      readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => appState,
      setAppState: updater => { appState = updater(appState) },
      setInProgressToolUseIDs() {}, setResponseLength() {},
      updateFileHistoryState() {}, updateAttributionState() {},
      setMessages() {}, onChangeAPIKey() {},
      messages: [], mods: runtime,
    }
    let reads = 0
    const params: QueryParams = {
      messages: [createUserMessage({ content: 'public question' })],
      systemPrompt: asSystemPrompt(['system marker']),
      userContext: { claudeMd: 'stale QueryParams context' }, systemContext: {},
      refreshUserContext: async () => {
        reads++
        return { claudeMd: await readFile(contextFile, 'utf8') }
      },
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      toolUseContext, querySource: 'repl_main_thread',
      deps: {
        uuid: randomUUID,
        microcompact: async messages => ({ messages }),
        autocompact: async () => ({ wasCompacted: false }),
        // Keep the real API assembly, Anthropic SDK serialization and SSE parser.
        callModel: queryModelWithStreaming,
      },
    }
    const drain = async (overrides: Partial<QueryParams> = {}) => {
      const iterator = runQuery({ ...params, ...overrides })
      const events = []
      while (true) {
        const next = await iterator.next()
        if (next.done) {
          expect(next.value).toEqual({ reason: 'completed' })
          break
        }
        events.push(next.value)
      }
      expect(events.filter(event => event.type === 'assistant')).toContainEqual(
        expect.objectContaining({ message: expect.objectContaining({
          content: [{ type: 'text', text: 'OK' }],
        }) }),
      )
      return events
    }
    const dispatch = async (tool: string) => {
      const snapshot = runtime.capture()
      try {
        return await snapshot.dispatch('tool.call', { tool }, async () => ({ result: 'unhandled' }))
      } finally {
        snapshot.release()
      }
    }
    const assertWire = (index: number, value: string, runs: number, question: string) => {
      const request = requests[index]!
      expect(request.stream).toBe(true)
      expect(request.messages[0]?.role).toBe('user')
      const content = request.messages.flatMap(message =>
        typeof message.content === 'string' ? [message.content] :
          message.content.flatMap(block => block.type === 'text' ? [block.text] : []),
      )
      const reminders = content.filter(text => text.includes("As you answer the user's questions"))
      expect(reminders).toHaveLength(1)
      expect(content[0]).toBe(reminders[0])
      expect(reminders[0]).toContain(`# 9\nwire:${value}:${runs}\n# 2\ntail:${runs}`)
      expect(reminders[0]).not.toContain('stale QueryParams context')
      expect(reminders[0]).not.toContain('# claudeMd')
      expect(content.join('\n')).toContain(question)
      expect(JSON.stringify(request.system)).not.toContain('wire:')
    }

    // prependUserContext intentionally does nothing in NODE_ENV=test.
    const { enableConfigs } = await import('../../utils/config.js')
    enableConfigs()
    process.env.NODE_ENV = 'development'
    await drain()
    expect(requests).toHaveLength(1)
    assertWire(0, 'first', 1, 'public question')
    expect(reads).toBe(1)
    expect(await dispatch('ContextRuns')).toEqual({ result: 1 })

    await writeFile(contextFile, 'second')
    await drain()
    expect(requests).toHaveLength(2)
    assertWire(1, 'first', 1, 'public question')
    expect(reads).toBe(1)
    expect(await dispatch('ContextRuns')).toEqual({ result: 1 })

    expect(await dispatch('InvalidateContext')).toEqual({ result: 1 })
    await drain()
    expect(requests).toHaveLength(3)
    assertWire(2, 'second', 2, 'public question')
    expect(reads).toBe(2)
    expect(await dispatch('ContextRuns')).toEqual({ result: 2 })

    // A persisted boundary invalidates once; another query with the same UUID
    // retains that context even if its source has since changed.
    const boundary = createCompactBoundaryMessage('manual', 100)
    const messages = [boundary, createUserMessage({ content: 'persisted summary' })]
    await writeFile(contextFile, 'persisted')
    await drain({ messages })
    assertWire(3, 'persisted', 3, 'persisted summary')
    await writeFile(contextFile, 'not yet visible')
    await drain({ messages })
    expect(requests).toHaveLength(5)
    assertWire(4, 'persisted', 3, 'persisted summary')
    expect(reads).toBe(3)
    expect(await dispatch('ContextRuns')).toEqual({ result: 3 })

    // Force a second model iteration, then inject a successful auto-compaction
    // result. The real query must reread before its very next SDK request.
    let stops = 0
    registerHookCallbacks({ Stop: [{ hooks: [{
      type: 'callback',
      callback: async () => ++stops === 1
        ? { decision: 'block', reason: 'continue for context refresh' }
        : { continue: true },
    }] }] })
    let compactions = 0
    const refreshed: import('../../utils/forkedAgent.js').CacheSafeParams[] = []
    const autoBoundary = createCompactBoundaryMessage('auto', 100)
    const events = await drain({
      messages,
      onCacheSafeParams: params => { refreshed.push(params) },
      deps: {
        ...params.deps!,
        autocompact: async () => {
          if (++compactions !== 2) return { wasCompacted: false }
          await writeFile(contextFile, 'after auto compact')
          return {
            wasCompacted: true,
            compactionResult: {
              boundaryMarker: autoBoundary,
              summaryMessages: [createUserMessage({ content: 'auto compact summary' })],
              attachments: [], hookResults: [],
            },
          }
        },
      },
    })
    expect(stops).toBe(2)
    expect(compactions).toBe(2)
    expect(events).toContainEqual(autoBoundary)
    expect(requests).toHaveLength(7)
    assertWire(5, 'persisted', 3, 'persisted summary')
    assertWire(6, 'after auto compact', 4, 'auto compact summary')
    expect(JSON.stringify(requests[6]!.messages)).not.toContain('wire:persisted')
    expect(reads).toBe(4)
    expect(await dispatch('ContextRuns')).toEqual({ result: 4 })
    expect(sampled).toHaveLength(7)
    expect(refreshed.map(params => params.resolvedPromptContextBlocks)).toEqual([
      [{name:'9',text:'wire:persisted:3'},{name:'2',text:'tail:3'}],
      [{name:'9',text:'wire:after auto compact:4'},{name:'2',text:'tail:4'}],
    ])
    const stopped = getLastCacheSafeParams()
    expect(stopped).not.toBeNull()
    await dispatch('InvalidateContext')
    for (const cacheSafeParams of [sampled.at(-1)!, stopped!, refreshed.at(-1)!]) {
      await runForkedAgent({
        cacheSafeParams, promptMessages: [createUserMessage({content:'cached side question'})],
        canUseTool: params.canUseTool, querySource:'agent_summary', forkLabel:'context', skipTranscript:true,
      })
      assertWire(requests.length - 1, 'after auto compact', 4, 'cached side question')
      expect(await dispatch('ContextRuns')).toEqual({result:4})
    }
    const { call: btw } = await import('../../commands/btw/btw.js')
    const { render } = await import('../../ink.js')
    const { Readable, Writable } = await import('node:stream')
    const painted = Promise.withResolvers<void>()
    let output = ''
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) {
      output += chunk.toString()
      if (output.includes('OK')) painted.resolve()
      done()
    } }), { columns: 100, rows: 30, isTTY: false })
    const stdin = Object.assign(new Readable({ read() {} }), {
      isTTY: true, isRaw: false, setRawMode() { return this }, ref() { return this }, unref() { return this },
    })
    const { createElement } = await import('react')
    const { AppStoreContext } = await import('../../state/AppState.js')
    const { createStore } = await import('../../state/store.js')
    const node = await btw(() => {}, toolUseContext, 'cached UI side question')
    const instance = await render(createElement(AppStoreContext.Provider, {value: createStore(appState)}, node), {
      stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false, exitOnCtrlC: false,
    })
    const deadline = setTimeout(() => painted.reject(new Error(`Side question did not render its answer: ${output}`)), 10_000)
    try {
      await painted.promise
      assertWire(requests.length - 1, 'after auto compact', 4, 'cached UI side question')
      expect(await dispatch('ContextRuns')).toEqual({result:4})
    } finally {
      clearTimeout(deadline)
      instance.unmount()
      instance.cleanup()
    }
    const { clearSessionCaches } = await import('../../commands/clear/caches.js')
    clearSessionCaches(new Set(['preserved-background-agent']))
    expect(getLastCacheSafeParams()).toBeNull()
    expect(stopped!.resolvedPromptContextBlocks).toEqual([
      {name:'9',text:'wire:after auto compact:4'},{name:'2',text:'tail:4'},
    ])
    expect(diagnostics).toEqual([])
    expect(unexpectedIO).toEqual([])
  } finally {
    clearPostSamplingHooks()
    saveCacheSafeParams(null)
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    resetStateForTests()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('Worker usage summary avoids provider calls while full counts using the captured model and public projection', async () => {
  const {mkdtemp,writeFile,rm} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {z} = await import('zod/v4')
  const {createModsRuntime} = await import('../mods/runtime.js')
  const {captureModSessionUsage,validateModSessionUsage} = await import('../mods/sessionUsage.js')
  const validateUsage: typeof validateModSessionUsage = validateModSessionUsage
  const {getDefaultAppState} = await import('../../state/AppStateStore.js')
  const root = await mkdtemp(join(tmpdir(),'mods-usage-wire-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  const state = getDefaultAppState()
  const context = {
    messages:[createUserMessage({content:'usage context'})],getAppState:() => state,
    options:{mainLoopModel:'claude-sonnet-5',tools:[{
      name:'FixtureTool',inputSchema:z.object({value:z.string()}),
      description:async () => 'FIXTURE_DESCRIPTION',prompt:async () => 'FIXTURE_PROMPT',
    }] as unknown as import('../../Tool.js').Tools,
    agentDefinitions:{activeAgents:[],allAgents:[],allowedAgentTypes:undefined}},
  }
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry,`export function register(on) {
      on('tool.call',async ($,e) => ({result:await $.session.usage({breakdown:e.breakdown,columns:e.columns})}));
    }`)
    await runtime.reconcile([{name:'usage-wire',storageId:'usage-wire@inline',pluginRoot:root,entrypoints:[entry]}])
    let captures=0
    const snapshot=runtime.capture({captureUsage:() => {captures++;return captureModSessionUsage(context)}})
    try {
      const invoke=async (breakdown:'summary'|'full'): Promise<ModSessionUsage> => {
        const response=await snapshot.dispatch('tool.call',{breakdown,columns:40},async () => ({result:'unhandled'})) as {result:unknown}
        expect(diagnostics).toEqual([])
        validateUsage(response.result)
        return response.result
      }
      const summary=await invoke('summary')
      expect(summary.context.breakdown?.model).toBe('claude-sonnet-5')
      expect(summary.context.breakdown?.gridRows[0]).toHaveLength(5)
      expect(summary.context.breakdown).not.toHaveProperty('messageBreakdown')
      expect(tokenRequests).toHaveLength(0)
      expect(requests).toHaveLength(0)
      const full=await invoke('full')
      expect(full.context.breakdown?.model).toBe('claude-sonnet-5')
      expect(tokenRequests.length).toBeGreaterThan(0)
      expect(tokenRequests.every(request=>request.model==='claude-sonnet-5')).toBe(true)
      const toolRequests=tokenRequests.filter(request=>
        Array.isArray(request.tools) && request.tools.some(tool=>
          typeof tool==='object' && tool!==null && 'name' in tool && tool.name==='FixtureTool',
        ),
      )
      expect(toolRequests).toHaveLength(1)
      expect((toolRequests[0]!.tools as unknown[])).toHaveLength(1)
      expect(requests).toHaveLength(0)
      expect(captures).toBe(2)
      expect(diagnostics).toEqual([])
      expect(unexpectedIO).toEqual([])
    } finally {snapshot.release()}
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('Mods named sections reach the actual SDK system field and invalidate on the next query', async () => {
  const {mkdtemp,writeFile,rm} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os')
  const {join} = await import('node:path')
  const {randomUUID} = await import('node:crypto')
  const {query:runQuery} = await import('../../query.js')
  const {createModsRuntime} = await import('../mods/runtime.js')
  const {getDefaultAppState} = await import('../../state/AppStateStore.js')
  const {createFileStateCacheWithSizeLimit} = await import('../../utils/fileStateCache.js')
  const {withSystemPromptSections} = await import('../../utils/systemPromptType.js')
  const root = await mkdtemp(join(tmpdir(),'mods-section-wire-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({onDiagnostic:event => diagnostics.push(event)})
  try {
    const entry = join(root,'register.ts')
    await writeFile(entry,`let calls=0;export function register(on) {
      on('prompt.section',($,e) => ({text:e.name==='drop' ? null : 'SECTION_'+e.name+'_'+(++calls)}));
      on('tool.call',async $ => {await $.ui.invalidate('prompt.section');return {result:'invalidated'}});
    }`)
    await runtime.reconcile([{name:'section-wire',storageId:'section-wire@inline',pluginRoot:root,entrypoints:[entry]}])
    let state = getDefaultAppState()
    const context: import('../../Tool.js').ToolUseContext = {
      options:{commands:[],debug:false,mainLoopModel:'claude-sonnet-5',tools:[],verbose:false,
        thinkingConfig:{type:'disabled'},mcpClients:[],mcpResources:{},isNonInteractiveSession:true,
        agentDefinitions:{activeAgents:[],allAgents:[],allowedAgentTypes:undefined}},
      abortController:new AbortController(),readFileState:createFileStateCacheWithSizeLimit(10),
      getAppState:() => state,setAppState:update => {state=update(state)},
      setInProgressToolUseIDs(){},setResponseLength(){},updateFileHistoryState(){},updateAttributionState(){},
      messages:[],mods:runtime,
    }
    const params: QueryParams = {
      messages:[createUserMessage({content:'section question'})],
      systemPrompt:withSystemPromptSections([
        {name:'identity',text:'OLD_IDENTITY'}, {name:'drop',text:'DROPPED_SECTION'},
        {name:'memory',text:null},{text:'APPEND_LITERAL'},
      ]),userContext:{},systemContext:{},
      canUseTool:async () => ({behavior:'allow',updatedInput:{}}),toolUseContext:context,querySource:'repl_main_thread',
      deps:{uuid:randomUUID,microcompact:async messages => ({messages}),autocompact:async () => ({wasCompacted:false}),callModel:queryModelWithStreaming},
    }
    const run = async () => {
      const generator = runQuery(params)
      for (;;) {const next=await generator.next();if(next.done){expect(next.value.reason).toBe('completed');break}}
    }
    await run();await run()
    expect(requests).toHaveLength(2)
    const wire = (index:number) => JSON.stringify(requests[index]!.system)
    expect(wire(0)).toContain('SECTION_identity_1')
    expect(wire(0)).toContain('SECTION_memory_2')
    expect(wire(0)).toContain('APPEND_LITERAL')
    expect(wire(0)).not.toContain('OLD_IDENTITY')
    expect(wire(0)).not.toContain('DROPPED_SECTION')
    expect(wire(0)).not.toContain('systemPromptSections')
    expect(wire(1)).toBe(wire(0))
    expect(await runtime.dispatch('tool.call',{},async () => ({result:'unhandled'}))).toEqual({result:'invalidated'})
    await run()
    expect(requests).toHaveLength(3)
    expect(wire(2)).toContain('SECTION_identity_3')
    expect(wire(2)).toContain('SECTION_memory_4')
    const {getSystemPrompt} = await import('../../constants/prompts.js')
    const {concatSystemPrompts,getSystemPromptSections} = await import('../../utils/systemPromptType.js')
    const source = await getSystemPrompt([],context.options.mainLoopModel,[],[])
    const named = getSystemPromptSections(source)!.filter(section => 'name' in section)
    expect(named).toContainEqual({name:'language',text:null})
    expect(named.some(section => section.name==='system')).toBe(true)
    params.systemPrompt = concatSystemPrompts(source,['SOURCE_APPEND_LITERAL'])
    await runtime.dispatch('tool.call',{},async () => ({result:'unhandled'}))
    await run()
    expect(requests).toHaveLength(4)
    for (const section of named) expect(wire(3)).toContain('SECTION_'+section.name+'_')
    expect(wire(3)).toContain('SOURCE_APPEND_LITERAL')
    expect(wire(3)).not.toContain('You are Claude Code')
    const { buildSideQuestionFallbackParams } = await import('../../utils/queryContext.js')
    const { runSideQuestion } = await import('../../utils/sideQuestion.js')
    const fallback = await buildSideQuestionFallbackParams({
      tools: [], commands: [], mcpClients: [], messages: params.messages,
      readFileState: context.readFileState, getAppState: context.getAppState, setAppState: context.setAppState,
      customSystemPrompt: undefined, appendSystemPrompt: 'SIDE_APPEND_LITERAL',
      thinkingConfig: { type: 'disabled' }, agents: [], mods: runtime,
    })
    expect((await runSideQuestion({ question: 'side question', cacheSafeParams: fallback })).response).toBe('OK')
    expect(requests).toHaveLength(5)
    for (const section of named) expect(wire(4)).toContain('SECTION_' + section.name + '_')
    expect(wire(4)).toContain('SIDE_APPEND_LITERAL')
    const { getCLISyspromptPrefix } = await import('../../constants/system.js')
    const sdkPrefix = getCLISyspromptPrefix({ isNonInteractive: true, hasAppendSystemPrompt: true })
    const sideBlocks = requests[4]!.system as Array<{ text: string }>
    expect(sideBlocks.filter(block => block.text === sdkPrefix)).toHaveLength(1)
    expect(sideBlocks.filter(block => block.text !== sdkPrefix).map(block => block.text).join('\n')).not.toContain('You are Claude Code')
    expect(diagnostics).toEqual([])
    expect(unexpectedIO).toEqual([])
  } finally {await runtime.dispose();await rm(root,{recursive:true,force:true})}
})

test('teammate named sections survive runAgent enhancement and reach the SDK without naming custom replacement text', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createModsRuntime } = await import('../mods/runtime.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
  const { spawnInProcessTeammate } = await import('../../utils/swarm/spawnInProcess.js')
  const { runInProcessTeammate } = await import('../../utils/swarm/inProcessRunner.js')
  const { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } = await import('../../utils/swarm/teammatePromptAddendum.js')
  const root = await mkdtemp(join(tmpdir(), 'mods-teammate-section-wire-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  const controllers: AbortController[] = []
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('prompt.section', ($, e) => ({text: 'TEAM_SECTION_' + e.name}));
    }`)
    await runtime.reconcile([{ name: 'teammate-sections', storageId: 'teammate-sections@inline', pluginRoot: root, entrypoints: [entry] }])
    let state = getDefaultAppState()
    const context: import('../../Tool.js').ToolUseContext = {
      options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-5', tools: [], verbose: false,
        thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined } },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => state, setAppState: update => { state = update(state) },
      setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
      messages: [], mods: runtime,
    }
    for (const mode of ['append', 'replace'] as const) {
      const spawned = await spawnInProcessTeammate({
        name: mode, teamName: 'offline-sections', prompt: 'answer once', planModeRequired: false, permissionMode: 'default',
      }, { setAppState: context.setAppState })
      expect(spawned.success).toBe(true)
      if (!spawned.taskId || !spawned.abortController || !spawned.teammateContext) throw new Error('Missing teammate state')
      const controller = spawned.abortController
      controllers.push(controller)
      const task = state.tasks[spawned.taskId]!
      if (task.type !== 'in_process_teammate') throw new Error('Unexpected teammate task')
      state = { ...state, tasks: { ...state.tasks, [task.id]: {
        ...task, onIdleCallbacks: [() => controller.abort()],
      } } }
      const result = await runInProcessTeammate({
        identity: task.identity, taskId: task.id, prompt: 'answer once', description: 'offline section consumer',
        model: 'claude-sonnet-5', teammateContext: spawned.teammateContext, toolUseContext: context,
        abortController: controller, systemPromptMode: mode, systemPrompt: 'OPAQUE_' + mode,
      })
      expect(result.success).toBe(true)
    }
    expect(requests).toHaveLength(2)
    const appended = JSON.stringify(requests[0]!.system)
    expect(appended).toContain('TEAM_SECTION_identity')
    expect(appended).toContain('TEAM_SECTION_language')
    expect(appended).toContain(JSON.stringify(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).slice(1, -1))
    expect(appended).toContain('OPAQUE_append')
    expect(appended).toContain('Notes:')
    expect(appended).not.toContain('You are Claude Code')
    const replaced = JSON.stringify(requests[1]!.system)
    expect(replaced).toContain('OPAQUE_replace')
    expect(replaced).toContain('Notes:')
    expect(replaced).not.toContain('TEAM_SECTION_')
    expect(replaced).not.toContain(JSON.stringify(TEAMMATE_SYSTEM_PROMPT_ADDENDUM).slice(1, -1))
    expect(diagnostics).toEqual([])
    expect(unexpectedIO).toEqual([])
  } finally {
    controllers.forEach(controller => controller.abort())
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('agent summary forks retain resolved section and ordered context bytes after invalidation and reload', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createModsRuntime } = await import('../mods/runtime.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
  const { withSystemPromptSections, getSystemPromptSections } = await import('../../utils/systemPromptType.js')
  const { runAgent } = await import('../../tools/AgentTool/runAgent.js')
  const { GENERAL_PURPOSE_AGENT } = await import('../../tools/AgentTool/built-in/generalPurposeAgent.js')
  const { runForkedAgent } = await import('../../utils/forkedAgent.js')
  const root = await mkdtemp(join(tmpdir(), 'mods-summary-section-wire-'))
  const originalNodeEnv = process.env.NODE_ENV
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
  try {
    const entry = join(root, 'register.ts')
    const plugin = { name: 'summary-sections', storageId: 'summary-sections@inline', pluginRoot: root, entrypoints: [entry] }
    const source = (version: string) => `let calls=0, contexts=0;export function register(on) {
      on('prompt.section', ($, e) => ({text: '${version}_' + e.name + '_' + (++calls)}));
      on('prompt.context', () => ({blocks:[{name:'9',text:'${version}_CONTEXT_'+(++contexts)},{name:'2',text:'ORDERED_TAIL'}]}));
      on('tool.call', async $ => {
        await $.ui.invalidate('prompt.section');await $.ui.invalidate('prompt.context');
        return {result:{calls,contexts}};
      });
    }`
    await writeFile(entry, source('ORIGINAL'))
    await runtime.reconcile([plugin])
    let state = getDefaultAppState()
    const context: import('../../Tool.js').ToolUseContext = {
      options: { commands: [], debug: false, mainLoopModel: 'claude-sonnet-5', tools: [], verbose: false,
        thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined } },
      abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
      getAppState: () => state, setAppState: update => { state = update(state) },
      setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
      messages: [], mods: runtime,
    }
    const captured: import('../../utils/forkedAgent.js').CacheSafeParams[] = []
    const { enableConfigs } = await import('../../utils/config.js')
    enableConfigs()
    process.env.NODE_ENV = 'development'
    const canUseTool = async () => ({ behavior: 'allow' as const, updatedInput: {} })
    const agent = runAgent({
      agentDefinition: GENERAL_PURPOSE_AGENT,
      baseSystemPrompt: withSystemPromptSections([{ name: 'identity', text: 'UNRESOLVED_IDENTITY' }]),
      promptMessages: [createUserMessage({ content: 'answer once' })],
      toolUseContext: context, canUseTool, isAsync: false, querySource: 'agent:test', availableTools: [],
      override: { userContext: {}, systemContext: {} },
      onCacheSafeParams: params => { captured.push({ ...params, forkContextMessages: [...params.forkContextMessages] }) },
    })
    for (;;) { if ((await agent.next()).done) break }
    expect(captured).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]!.system)).toContain('ORIGINAL_identity_1')
    expect(JSON.stringify(requests[0]!.messages)).toContain('# 9\\nORIGINAL_CONTEXT_1\\n# 2\\nORDERED_TAIL')
    expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'unhandled' }))).toEqual({ result: { calls: 1, contexts: 1 } })
    for (const reload of [false, true]) {
      if (reload) {
        await writeFile(entry, source('RELOADED'))
        await runtime.reconcile([plugin])
      }
      await runForkedAgent({
        cacheSafeParams: captured[0]!, promptMessages: [createUserMessage({ content: 'summarize' })],
        canUseTool, querySource: 'agent_summary', forkLabel: 'summary', skipTranscript: true,
      })
      expect(requests.at(-1)!.system).toEqual(requests[0]!.system)
      const firstContent = requests[0]!.messages[0]!.content
      const forkContent = requests.at(-1)!.messages[0]!.content
      expect(Array.isArray(firstContent)).toBe(true)
      expect(Array.isArray(forkContent)).toBe(true)
      if (!Array.isArray(firstContent) || !Array.isArray(forkContent)) throw new Error('Expected SDK content blocks')
      expect(forkContent[0]).toEqual(firstContent[0])
      expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'unhandled' }))).toEqual({
        result: { calls: reload ? 0 : 1, contexts: reload ? 0 : 1 },
      })
    }
    expect(requests).toHaveLength(3)
    expect(getSystemPromptSections(captured[0]!.systemPrompt)).toBeUndefined()
    expect(captured[0]!.toolUseContext.renderedSystemPrompt).toBe(captured[0]!.systemPrompt)
    expect(context.renderedSystemPrompt).toBeUndefined()
    expect(diagnostics).toEqual([])
    expect(unexpectedIO).toEqual([])
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
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
}
