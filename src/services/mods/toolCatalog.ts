import type { Tool, ToolUseContext } from '../../Tool.js'
import { isDeferredTool } from '../../tools/ToolSearchTool/prompt.js'
import type { ModSnapshot } from './runtime.js'
import type { ModOrigin } from './types.js'

export type ToolInfo = { name: string; description: string; mcp: boolean }
export type ToolCatalog = ReturnType<typeof createToolCatalog>

/** A projection of an already-admitted tool set, never a tool registry. */
export function createToolCatalog(
  tools: readonly Tool[],
  describe: (tool: Tool) => Promise<string>,
) {
  const admitted = new Map(tools.map(tool => [tool.name, tool]))
  if (admitted.size !== tools.length)
    throw new Error('tool.list requires unique canonical tool names')
  let descriptions: Promise<ToolInfo[]> | undefined
  async function list(): Promise<ToolInfo[]> {
    descriptions ??= Promise.all(
      tools.map(async tool => ({
        name: tool.name,
        description: await describe(tool),
        mcp: tool.isMcp === true,
      })),
    )
    // Each continuation gets its own values; no branch may change another's core.
    return (await descriptions).map(info => ({ ...info }))
  }
  function validateResult(
    value: unknown,
  ): asserts value is { value: ToolInfo[] } | { deny: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('tool.list must return value or deny')
    if ('deny' in value && typeof value.deny === 'string') return
    if (!('value' in value) || !Array.isArray(value.value))
      throw new Error('tool.list value must be an array')
    const seen = new Set<string>()
    for (const info of value.value) {
      if (
        !info ||
        typeof info !== 'object' ||
        Array.isArray(info) ||
        typeof info.name !== 'string' ||
        typeof info.description !== 'string' ||
        typeof info.mcp !== 'boolean' ||
        Object.keys(info).some(
          key => key !== 'name' && key !== 'description' && key !== 'mcp',
        )
      )
        throw new Error(
          'tool.list entries must contain only name, description and mcp',
        )
      if (!admitted.has(info.name))
        throw new Error(
          `tool.list cannot add unknown or gated tool ${info.name}`,
        )
      if (seen.has(info.name))
        throw new Error(`tool.list cannot duplicate tool ${info.name}`)
      seen.add(info.name)
    }
  }
  return {
    list,
    validateResult,
    async project(
      snapshot?: ModSnapshot,
      signal?: AbortSignal,
    ): Promise<{ tool: Tool; description: string }[]> {
      signal?.throwIfAborted()
      const result = snapshot?.hasHooks('tool.list')
        ? await snapshot.dispatch(
            'tool.list',
            {},
            async () => ({ value: await list() }),
            { signal, validateResult },
          )
        : { value: await list() }
      signal?.throwIfAborted()
      validateResult(result)
      if ('deny' in result) throw new Error(result.deny)
      return result.value.map(info => ({
        tool: admitted.get(info.name)!,
        description: info.description,
      }))
    },
  }
}

/** The author's core leaf shares the session's real tools and unmodified schemas. */
export function createToolCatalogForContext(
  context: ToolUseContext,
): ToolCatalog {
  const tools = context.options.tools
  return createToolCatalog(tools, async tool => {
    const { toolToAPISchema } = await import('../../utils/api.js')
    const schema = await toolToAPISchema(tool, {
      tools,
      agents: context.options.agentDefinitions.activeAgents,
      getToolPermissionContext: async () =>
        context.getAppState().toolPermissionContext,
      model: context.options.mainLoopModel,
    })
    return 'description' in schema ? (schema.description ?? '') : ''
  })
}

export type ModToolDescription = { description: string; isDeferred?: boolean }

export async function describeModTool(
  snapshot: ModSnapshot,
  tool: Tool,
  description: string,
  signal?: AbortSignal,
): Promise<ModToolDescription> {
  signal?.throwIfAborted()
  const isDeferred = isDeferredTool(tool)
  if (!snapshot.hasHooks('tool.describe')) return { description }
  const mcp = tool.mcpInfo
  let provider: ModOrigin
  if (mcp?.scope === 'enterprise' || mcp?.scope === 'managed') {
    provider = { plugin: `mcp:${mcp.serverName}`, tier: 'prepend' }
  } else if (mcp?.pluginSource) {
    const origin = snapshot.pluginOrigin?.(mcp.pluginSource)
    if (!origin)
      throw new Error(
        `Mods snapshot cannot resolve MCP plugin provider ${mcp.pluginSource}`,
      )
    provider = origin
  } else {
    provider = mcp
      ? { plugin: `mcp:${mcp.serverName}`, tier: 'user' }
      : tool.isMcp
        ? { plugin: 'mcp', tier: 'user' }
        : { plugin: 'engine', tier: 'core' }
  }
  // Runtime owns generation/invalidation rotation; absent that contract, do not
  // substitute a TTL or session-global transformed description cache.
  const cache = snapshot.toolDescriptions
  let byDescription = cache?.get(tool)
  if (cache && !byDescription) {
    byDescription = new Map()
    cache.set(tool, byDescription)
  }
  let result = byDescription?.get(description)
  if (!result) {
    result = snapshot
      .dispatch(
        'tool.describe',
        {
          tool: tool.name,
          description,
          provider,
          ...(isDeferred && { isDeferred: true }),
        },
        async input => ({
          description: input.description,
          ...(input.isDeferred === true && { isDeferred: true }),
        }),
        {
          signal,
          restoreInput: (input, received) =>
            Object.hasOwn(input, 'provider')
              ? input
              : { ...input, provider: received.provider },
          validateInput: (input, received) => {
            if (input.tool !== tool.name)
              throw new Error('tool.describe cannot rewrite tool')
            if (typeof input.description !== 'string')
              throw new Error('tool.describe must provide description')
            if (input.isDeferred !== undefined && input.isDeferred !== true)
              throw new Error(
                'tool.describe input isDeferred must be true or absent',
              )
            if (
              input.description !== received.description &&
              input.description.length > 32000
            )
              throw new Error('tool.describe text exceeds 32000 characters')
          },
          validateResult: value => {
            // Shape and pinned provider are checked by the existing runtime.
            const { description: text, isDeferred } =
              value as ModToolDescription
            if (isDeferred !== undefined && typeof isDeferred !== 'boolean')
              throw new Error('tool.describe result isDeferred must be boolean')
            if (text !== description && text.length > 32000)
              throw new Error('tool.describe text exceeds 32000 characters')
          },
        },
      )
      .then(value => value as ModToolDescription)
    byDescription?.set(description, result)
    void result.catch(() => {
      if (byDescription?.get(description) === result)
        byDescription.delete(description)
    })
  }
  const answer = await result
  signal?.throwIfAborted()
  return answer
}
