import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolUseContext,
} from '../../Tool.js'
import { toolToAPISchema, toolsToAPISchemas } from '../../utils/api.js'
import { clearFetchToolsCache, fetchToolsForClient } from '../mcp/client.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../mcp/types.js'
import {
  createToolCatalog,
  createToolCatalogForContext,
} from './toolCatalog.js'
import {
  clearToolSchemaCache,
  getToolSchemaCache,
} from '../../utils/toolSchemaCache.js'
import {
  resetSettingsCache,
  setCachedSettingsForSource,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'
import { loadModDeclaration } from './loader.js'
import { seatNativeModPlugins } from './native.js'
import { createModsRuntime, type ModSnapshot } from './runtime.js'

let root: string
const runtimes: ReturnType<typeof createModsRuntime>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mods-tool-catalog-'))
  clearToolSchemaCache()
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const source of [
    'userSettings',
    'projectSettings',
    'localSettings',
    'flagSettings',
    'policySettings',
  ] as const)
    setCachedSettingsForSource(source, {})
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  clearToolSchemaCache()
  resetSettingsCache()
  await rm(root, { recursive: true, force: true })
})

function builtin(name = 'Read'): Tool {
  return {
    name,
    inputSchema: z.object({ path: z.string() }),
    inputJSONSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async prompt() {
      return `core ${name}`
    },
    async call() {
      return { data: 'host closure' }
    },
  } as unknown as Tool
}
async function mcpTool(
  serverName: string,
  scope: ScopedMcpServerConfig['scope'],
  skipPrefix = false,
  pluginSource?: string,
): Promise<Tool> {
  clearFetchToolsCache(serverName)
  const previous = process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
  if (skipPrefix) process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = '1'
  try {
    const tools = await fetchToolsForClient({
      name: serverName,
      type: 'connected',
      capabilities: { tools: {} },
      config: { type: 'sdk', name: serverName, scope, pluginSource },
      client: {
        request: async () => ({
          tools: [
            {
              name: 'find',
              description: `core ${serverName}`,
              inputSchema: { type: 'object', properties: {} },
              _meta: { provider: { plugin: 'forged', tier: 'user' } },
            },
          ],
        }),
      },
    } as unknown as MCPServerConnection)
    expect(tools).toHaveLength(1)
    return tools[0]!
  } finally {
    clearFetchToolsCache(serverName)
    if (previous === undefined)
      delete process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
    else process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = previous
  }
}

const schemaOptions = (tools: Tool[], modsSnapshot?: ModSnapshot) => ({
  tools,
  agents: [],
  getToolPermissionContext: async () => getEmptyToolPermissionContext(),
  modsSnapshot,
})

async function runtimeWithUser(
  source: string,
  implementation?: 'local' | 'official',
) {
  const path = join(root, 'register.ts')
  await writeFile(path, source)
  const diagnostics: string[] = []
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event.message),
  })
  runtimes.push(runtime)
  const plugins = [
    {
      name: 'person',
      storageId: 'person@inline',
      pluginRoot: root,
      entrypoints: [path],
      tier: 'user' as const,
    },
  ]
  if (implementation) {
    const policy = { allowedMcpServers: [{ serverName: 'corp' }] }
    setCachedSettingsForSource('policySettings', policy)
    const officialRoot = process.env.CLAUDE_CODE_OFFICIAL_MODS_FIXTURE
    if (implementation === 'official' && !officialRoot)
      throw new Error(
        'CLAUDE_CODE_OFFICIAL_MODS_FIXTURE is required for the official native test',
      )
    const declaration =
      implementation === 'official'
        ? await loadModDeclaration({
            name: 'sec-default',
            storageId: 'sec-default@inline',
            pluginRoot: join(officialRoot!, 'sec-default'),
            entrypoints: [join(officialRoot!, 'sec-default/hooks/register.ts')],
          })
        : undefined
    await runtime.reconcile(
      seatNativeModPlugins(
        plugins,
        {
          userSettings: null,
          flagSettings: null,
          policySettings: policy,
          hookPolicy: { managedOnly: false, allDisabled: false },
        },
        declaration,
      ),
    )
  } else {
    await runtime.reconcile(plugins)
  }
  await runtime.bind({
    cwd: root,
    sessionId: 'tool-catalog',
    surface: null,
    isInteractive: false,
  })
  return { runtime, diagnostics }
}

for (const implementation of ['local', 'official'] as const) {
  const officialAvailable =
    process.env.CLAUDE_CODE_OFFICIAL_MODS_FIXTURE !== undefined
  test.skipIf(implementation === 'official' && !officialAvailable)(
    `${implementation} native seating preserves ordinary tool.describe changes in the production schema helper`,
    async () => {
      const { runtime, diagnostics } = await runtimeWithUser(
        `export function register(on) {
        on('tool.describe', ($, event) => ({description: event.provider.plugin + '/' + event.provider.tier + ': user ' + event.tool}));
      }`,
        implementation,
      )
      const tool = builtin()
      const snapshot = runtime.capture()
      try {
        const schema = await toolToAPISchema(
          tool,
          schemaOptions([tool], snapshot),
        )
        expect(schema).toMatchObject({
          name: 'Read',
          description: 'engine/core: user Read',
        })
        expect(getToolSchemaCache().values().next().value?.description).toBe(
          'core Read',
        )
        expect((schema as any).input_schema).toBe(tool.inputJSONSchema)
        expect(diagnostics).toEqual([])
      } finally {
        snapshot.release()
      }
    },
  )

  test.skipIf(implementation === 'official' && !officialAvailable)(
    `${implementation} native list restores org MCP and retains user order/description without replacing Tool/schema/call`,
    async () => {
      const { runtime, diagnostics } = await runtimeWithUser(
        `export function register(on) {
        on('tool.list', async ($, e, next) => ({value:(await next(e)).value.filter(t => t.name !== 'mcp__corp__find' && t.name !== 'Hidden').reverse().map(t => ({...t,description:'listed '+t.name}))}));
        on('tool.describe', ($, e) => ({description:'described '+e.tool}));
      }`,
        implementation,
      )
      const corp = await mcpTool('corp', 'enterprise')
      const tools = [builtin(), corp, builtin('Grep'), builtin('Hidden')]
      const calls = tools.map(tool => tool.call)
      const schemas = tools.map(tool => tool.inputJSONSchema)
      const snapshot = runtime.capture()
      try {
        const projected = await toolsToAPISchemas(
          tools,
          schemaOptions(tools, snapshot),
        )
        expect(projected.tools).toEqual([corp, tools[2], tools[0]])
        expect(
          projected.schemas.map(schema =>
            'description' in schema ? schema.description : '',
          ),
        ).toEqual(['core corp', 'listed Grep', 'listed Read'])
        for (const [index, tool] of projected.tools.entries()) {
          const original = tools.indexOf(tool)
          expect(tool).toBe(tools[original])
          expect(tool.call).toBe(calls[original])
          expect((projected.schemas[index] as any).input_schema).toBe(
            schemas[original],
          )
        }
        expect(diagnostics).toEqual([])
      } finally {
        snapshot.release()
      }
    },
  )
}

for (const answer of [
  "[{name:'Unknown',description:'bad',mcp:false}]",
  "[{name:'Read',description:'a',mcp:false},{name:'Read',description:'b',mcp:false}]",
  "[{name:'ToolSearch',description:'resurrected',mcp:false}]",
  "[{name:'Read',description:42,mcp:false}]",
]) {
  test(`tool.list rejects invalid or gated catalog result ${answer}`, async () => {
    const { runtime, diagnostics } = await runtimeWithUser(
      `export function register(on) { on('tool.list', () => ({value:${answer}})); }`,
    )
    const tools = [builtin()]
    const snapshot = runtime.capture()
    try {
      const result = await toolsToAPISchemas(
        tools,
        schemaOptions([...tools, builtin('ToolSearch')], snapshot),
      )
      expect(result.tools).toEqual(tools)
      expect(result.schemas).toMatchObject([
        { name: 'Read', description: 'core Read' },
      ])
      expect(diagnostics.length).toBeGreaterThan(0)
      expect(diagnostics.join(' ')).toContain('tool.list')
    } finally {
      snapshot.release()
    }
  })
}

test('schema overlays keep deferral/cache controls and the full prompt context after list filtering', async () => {
  const { runtime, diagnostics } =
    await runtimeWithUser(`export function register(on) {
    on('tool.list', async ($, e, next) => ({value:[...(await next(e)).value].reverse()}));
  }`)
  const first = builtin()
  const second = builtin('Grep')
  const gated = builtin('ToolSearch')
  const full = [first, second, gated]
  let promptTools: unknown
  first.prompt = async options => {
    promptTools = options.tools
    return 'base'
  }
  const snapshot = runtime.capture()
  const marker = { type: 'ephemeral' as const }
  try {
    const result = await toolsToAPISchemas([first, second], {
      ...schemaOptions(full, snapshot),
      deferLoadingForTool: tool => tool === first,
      cacheControl: marker,
    })
    expect(promptTools).toBe(full)
    expect(result.tools).toEqual([second, first])
    expect(result.schemas[1]).toMatchObject({
      name: 'Read',
      description: 'base',
      defer_loading: true,
      cache_control: marker,
    })
    expect(result.schemas[0]).not.toHaveProperty('defer_loading')
    expect(result.schemas.every(schema => !('mcp' in schema))).toBe(true)
    expect(diagnostics).toEqual([])
  } finally {
    snapshot.release()
  }
})

test('context catalog uses real base descriptions and canonical host MCP flags', async () => {
  const tool = builtin()
  const corp = await mcpTool('corp', 'enterprise')
  const tools = [tool, corp]
  const context = {
    options: {
      tools,
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
  const catalog = createToolCatalogForContext(context)
  expect(await catalog.list()).toEqual([
    { name: 'Read', description: 'core Read', mcp: false },
    { name: 'mcp__corp__find', description: 'core corp', mcp: true },
  ])
  expect((await catalog.project()).map(value => value.tool)).toEqual(tools)
})

test('core leaf projects only ToolInfo and cannot expose schema, closure or caller mutation', async () => {
  const tool = builtin()
  const catalog = createToolCatalog([tool], async value =>
    value.prompt(schemaOptions([tool])),
  )
  const first = await catalog.list()
  expect(first).toEqual([
    { name: 'Read', description: 'core Read', mcp: false },
  ])
  first[0]!.description = 'mutated'
  expect(await catalog.list()).toEqual([
    { name: 'Read', description: 'core Read', mcp: false },
  ])
  expect(() =>
    catalog.validateResult({
      value: [{ name: 'Read', description: 'ok', call: 'forged' }],
    }),
  ).toThrow('tool.list')
  expect((await catalog.project())[0]!.tool).toBe(tool)
})

test('author $.tool.list uses the same host catalog through a real Worker', async () => {
  const { runtime, diagnostics } =
    await runtimeWithUser(`export function register(on) {
    on('tool.call', async ($) => ({result:await $.tool.list()}));
    on('tool.list', () => ({value:[{name:'ToolSearch',description:'must not return'}]}));
  }`)
  const tools = [builtin()]
  const snapshot = runtime.capture({
    toolCatalog: () =>
      createToolCatalog(tools, async tool => {
        const schema = await toolToAPISchema(tool, schemaOptions(tools))
        return 'description' in schema ? (schema.description ?? '') : ''
      }),
  })
  try {
    // The noun's own author is skipped by the existing runtime origin handling.
    expect(
      await snapshot.dispatch('tool.call', {}, async () => ({
        result: 'unreachable',
      })),
    ).toEqual({
      result: [{ name: 'Read', description: 'core Read', mcp: false }],
    })
    expect(diagnostics).toEqual([])
  } finally {
    snapshot.release()
  }
})

test('author $.tool.list rejects invalid downstream names at the continuation boundary', async () => {
  const entry = join(root, 'caller.ts')
  await writeFile(
    entry,
    `export function register(on) {
    on('tool.call', async ($) => ({result:await $.tool.list()}));
  }`,
  )
  const user = join(root, 'bad.ts')
  await writeFile(
    user,
    `export function register(on) {
    on('tool.list', () => ({value:[{name:'Unknown',description:'bad',mcp:false}]}));
  }`,
  )
  const diagnostics: string[] = []
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event.message),
  })
  runtimes.push(runtime)
  await runtime.reconcile([
    {
      name: 'caller',
      storageId: 'caller@inline',
      pluginRoot: root,
      entrypoints: [entry],
      tier: 'user',
    },
    {
      name: 'bad',
      storageId: 'bad@inline',
      pluginRoot: root,
      entrypoints: [user],
      tier: 'user',
    },
  ])
  const tool = builtin()
  const snapshot = runtime.capture({
    toolCatalog: () => createToolCatalog([tool], async () => 'host'),
  })
  try {
    expect(
      await snapshot.dispatch('tool.call', {}, async () => ({
        result: 'unreachable',
      })),
    ).toEqual({ result: [{ name: 'Read', description: 'host', mcp: false }] })
    expect(diagnostics.join(' ')).toContain(
      'tool.list cannot add unknown or gated tool Unknown',
    )
  } finally {
    snapshot.release()
  }
})

test('MCP provider uses canonical connection scope even with unprefixed model name', async () => {
  const { runtime, diagnostics } =
    await runtimeWithUser(`export function register(on) {
    on('tool.describe', ($, e) => ({description:e.provider.plugin+'/'+e.provider.tier}));
  }`)
  const snapshot = runtime.capture()
  try {
    for (const [scope, tier] of [
      ['enterprise', 'prepend'],
      ['managed', 'prepend'],
      ['user', 'user'],
    ] as const) {
      const tool = await mcpTool('canonical', scope, true)
      expect(tool.name).toBe('find')
      expect(
        await toolToAPISchema(tool, schemaOptions([tool], snapshot)),
      ).toMatchObject({ description: `mcp:canonical/${tier}` })
    }
    expect(diagnostics).toEqual([])
  } finally {
    snapshot.release()
  }
})

test('plugin MCP provider is its canonical storageId and captured admitted tier, unless policy config owns server', async () => {
  const entry = join(root, 'register.ts')
  await writeFile(
    entry,
    `export function register(on) {
    on('tool.describe', ($, e) => ({description:e.provider.plugin+'/'+e.provider.tier}));
  }`,
  )
  const runtime = createModsRuntime()
  runtimes.push(runtime)
  await runtime.reconcile([
    {
      name: 'not-storage-id',
      storageId: 'catalog@market',
      pluginRoot: root,
      entrypoints: [entry],
      tier: 'append',
    },
  ])
  const snapshot = runtime.capture()
  try {
    const user = await mcpTool(
      'not-the-plugin-name',
      'user',
      false,
      'catalog@market',
    )
    expect(
      await toolToAPISchema(user, schemaOptions([user], snapshot)),
    ).toMatchObject({ description: 'catalog@market/append' })
    const policy = await mcpTool(
      'policy-server',
      'enterprise',
      false,
      'catalog@market',
    )
    expect(
      await toolToAPISchema(policy, schemaOptions([policy], snapshot)),
    ).toMatchObject({ description: 'mcp:policy-server/prepend' })
  } finally {
    snapshot.release()
  }
})

test('configured plugin MCP without a hook module still receives canonical settings provider', async () => {
  setCachedSettingsForSource('policySettings', {
    enabledPlugins: { 'managed-no-hooks@market': true },
    appendPlugins: ['managed-no-hooks@market'],
  })
  const { runtime, diagnostics } =
    await runtimeWithUser(`export function register(on) {
    on('tool.describe', ($, e) => ({description:e.provider.plugin+'/'+e.provider.tier}));
  }`)
  const snapshot = runtime.capture()
  try {
    for (const [source, tier] of [
      ['ordinary-no-hooks@market', 'user'],
      ['managed-no-hooks@market', 'append'],
    ] as const) {
      const tool = await mcpTool(
        'canonical-plugin-server',
        'dynamic',
        false,
        source,
      )
      expect(
        await toolToAPISchema(tool, schemaOptions([tool], snapshot)),
      ).toMatchObject({ description: source + '/' + tier })
    }
    expect(diagnostics).toEqual([])
  } finally {
    snapshot.release()
  }
})

test('description cache follows real runtime generations, keeps leased snapshots and never dirties base schemas', async () => {
  const source = (label: string) => `export function register(on) {
    let count=0;
    on('tool.describe', ($, e) => ({description:'${label} '+(++count)+' '+e.tool}));
  }`
  const { runtime, diagnostics } = await runtimeWithUser(source('old'))
  const tools = [builtin()]
  const old = runtime.capture()
  const same = runtime.capture()
  try {
    expect(old.toolDescriptions).toBeDefined()
    expect(same.toolDescriptions).toBe(old.toolDescriptions)
    const render = (snapshot: ModSnapshot) =>
      toolToAPISchema(tools[0]!, schemaOptions(tools, snapshot))
    expect(await render(old)).toMatchObject({ description: 'old 1 Read' })
    expect(await render(same)).toMatchObject({ description: 'old 1 Read' })
    const path = join(root, 'register.ts')
    await writeFile(path, source('new'))
    await runtime.reconcile([
      {
        name: 'person',
        storageId: 'person@inline',
        pluginRoot: root,
        entrypoints: [path],
        tier: 'user',
      },
    ])
    const fresh = runtime.capture()
    try {
      expect(fresh.toolDescriptions).not.toBe(old.toolDescriptions)
      expect(await render(fresh)).toMatchObject({ description: 'new 1 Read' })
      expect(await render(old)).toMatchObject({ description: 'old 1 Read' })
      expect(
        await toolToAPISchema(tools[0]!, schemaOptions(tools)),
      ).toMatchObject({ description: 'core Read' })
      expect(getToolSchemaCache().values().next().value?.description).toBe(
        'core Read',
      )
      expect(diagnostics).toEqual([])
    } finally {
      fresh.release()
    }
  } finally {
    old.release()
    same.release()
  }
})

test('real author invalidation refreshes only generation descriptions, preserving base schema bytes', async () => {
  const { runtime, diagnostics } =
    await runtimeWithUser(`export function register(on) {
    let count=0;
    on('tool.describe', () => ({description:String(++count)}));
    on('tool.call', async ($) => {await $.ui.invalidate('tool.describe'); return {result:'invalidated'};});
  }`)
  const snapshot = runtime.capture()
  const tool = builtin()
  const render = () => toolToAPISchema(tool, schemaOptions([tool], snapshot))
  try {
    expect(await render()).toMatchObject({ description: '1' })
    const before = snapshot.toolDescriptions
    await snapshot.dispatch('tool.call', {}, async () => ({ result: 'core' }))
    expect(snapshot.toolDescriptions).not.toBe(before)
    expect(await render()).toMatchObject({ description: '2' })
    expect(getToolSchemaCache().values().next().value?.description).toBe(
      'core Read',
    )
    expect(diagnostics).toEqual([])
  } finally {
    snapshot.release()
  }
})

test('a snapshot without a generation cannot reuse transformed session descriptions', async () => {
  const { runtime } = await runtimeWithUser(`export function register(on) {
    let count=0; on('tool.describe', () => ({description:String(++count)}));
  }`)
  const captured = runtime.capture()
  const { toolDescriptions: _cache, ...snapshot } = captured
  const tools = [builtin()]
  try {
    expect(
      await toolToAPISchema(tools[0]!, schemaOptions(tools, snapshot)),
    ).toMatchObject({ description: '1' })
    expect(
      await toolToAPISchema(tools[0]!, schemaOptions(tools, snapshot)),
    ).toMatchObject({ description: '2' })
  } finally {
    captured.release()
  }
})

test('tool.describe restores omitted provider and rejects changed subject/oversized continuation or result', async () => {
  const { runtime, diagnostics } =
    await runtimeWithUser(`export function register(on) {
    on('tool.describe', {tool:'Read'}, ($, e, next) => next({tool:e.tool,description:'without provider'}));
    on('tool.describe', {tool:'Grep'}, ($, e, next) => next({...e,tool:'Read'}));
    on('tool.describe', {tool:'Glob'}, ($, e, next) => next({...e,description:'x'.repeat(32001)}));
    on('tool.describe', {tool:'Bash'}, () => ({description:'x'.repeat(32001)}));
  }`)
  const tools = ['Read', 'Grep', 'Glob', 'Bash'].map(builtin)
  const snapshot = runtime.capture()
  try {
    const result = await toolsToAPISchemas(
      tools,
      schemaOptions(tools, snapshot),
    )
    expect(result.schemas).toMatchObject([
      { description: 'without provider' },
      { description: 'core Grep' },
      { description: 'core Glob' },
      { description: 'core Bash' },
    ])
    expect(diagnostics).toHaveLength(3)
    expect(diagnostics.join(' ')).toContain('tool.describe cannot rewrite tool')
    expect(diagnostics.join(' ')).toContain('32000')
  } finally {
    snapshot.release()
  }
})

test('tool.describe next may rewrite description but cannot forge provider', async () => {
  const { runtime, diagnostics } =
    await runtimeWithUser(`export function register(on) {
    on('tool.describe', {tool:'Read'}, ($, e, next) => next({...e,description:'next description'}));
    on('tool.describe', {tool:'Grep'}, ($, e, next) => next({...e,provider:{plugin:'mcp:forged',tier:'prepend'}}));
  }`)
  const tools = [builtin(), builtin('Grep')]
  const snapshot = runtime.capture()
  try {
    const result = await toolsToAPISchemas(
      tools,
      schemaOptions(tools, snapshot),
    )
    expect(result.schemas).toMatchObject([
      { description: 'next description' },
      { description: 'core Grep' },
    ])
    expect(diagnostics).toEqual(['tool.describe cannot rewrite provider'])
  } finally {
    snapshot.release()
  }
})
