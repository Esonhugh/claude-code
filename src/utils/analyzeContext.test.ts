import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import type { Anthropic } from '@anthropic-ai/sdk'
import type { Message } from '../types/message.js'
import { withSystemPromptSections } from './systemPromptType.js'

const tokenEstimation = await import('../services/tokenEstimation.js')
const tokenCountRequests: Array<{ tool: string; model: string }> = []
const tokenCountSpy = spyOn(
  tokenEstimation,
  'countMessagesTokensWithAPI',
).mockImplementation(async (_messages, tools, model) => {
  if (tools.length !== 1) return null
  const tool = 'name' in tools[0]! ? tools[0]!.name : ''
  tokenCountRequests.push({ tool, model: model ?? '' })
  return tool === 'small' ? 510 : tool === 'large' ? 560 : null
})

const {
  buildContextUsageData,
  countMcpToolTokens,
  countToolSchemaTokens,
  estimateToolSchemaTokenAllocation,
  getLoadedDeferredToolNames,
  getNamedSystemPromptEntries,
} = await import('./analyzeContext.js')

afterAll(() => tokenCountSpy.mockRestore())

const schema = (
  name: string,
  description: string,
  propertyDescription: string,
): Anthropic.Beta.Messages.BetaToolUnion => ({
  name,
  description,
  input_schema: {
    type: 'object',
    properties: {
      value: { type: 'string', description: propertyDescription },
    },
  },
})

describe('getNamedSystemPromptEntries', () => {
  test('preserves explicit section names instead of inferring them from text', () => {
    const prompt = withSystemPromptSections([
      { name: 'identity', text: 'plain section text' },
      { name: 'removed', text: null },
      { text: '# Inferred fallback' },
    ])

    expect(getNamedSystemPromptEntries(prompt)).toEqual([
      { name: 'identity', content: 'plain section text' },
      { name: 'Inferred fallback', content: '# Inferred fallback' },
    ])
  })
})

describe('countToolSchemaTokens', () => {
  test('full detail preserves each tool API count with the explicit runtime model', async () => {
    tokenCountRequests.length = 0

    const details = await countToolSchemaTokens(
      [schema('small', 'short', 'short'), schema('large', 'long', 'long')],
      'runtime-model',
      'full',
    )

    expect(details).toEqual([
      { name: 'small', tokens: 10 },
      { name: 'large', tokens: 60 },
    ])
    expect(tokenCountRequests).toEqual([
      { tool: 'small', model: 'runtime-model' },
      { tool: 'large', model: 'runtime-model' },
    ])
  })
})

describe('countMcpToolTokens', () => {
  test('summary stays local while preserving per-tool schema weights', async () => {
    tokenCountRequests.length = 0
    const tool = (
      name: string,
      description: string,
    ) => ({
      name,
      isMcp: true,
      inputJSONSchema: { type: 'object', properties: {} },
      prompt: async () => description,
    })

    const result = await countMcpToolTokens(
      [tool('small', 'short'), tool('large', 'long '.repeat(100))] as never,
      async () => ({ mode: 'default' }) as never,
      { activeAgents: [], allAgents: [] } as never,
      'runtime-model',
      undefined,
      'summary',
    )

    expect(tokenCountRequests).toEqual([])
    expect(result.mcpToolDetails.find(item => item.name === 'large')!.tokens).toBeGreaterThan(
      result.mcpToolDetails.find(item => item.name === 'small')!.tokens,
    )
  })
})

describe('estimateToolSchemaTokenAllocation', () => {
  test('weights production name, description, and JSON schema', () => {
    const details = estimateToolSchemaTokenAllocation(
      [
        schema('small', 'short', 'short'),
        schema(
          'large',
          'A substantially longer production tool description '.repeat(20),
          'A substantially longer JSON schema description '.repeat(20),
        ),
      ],
      1_000,
    )

    expect(details.find(tool => tool.name === 'large')!.tokens).toBeGreaterThan(
      details.find(tool => tool.name === 'small')!.tokens,
    )
  })

  test('does not reallocate excluded Skill tokens to other tools', () => {
    const details = estimateToolSchemaTokenAllocation(
      [
        schema('Read', 'read files', 'path'),
        schema('Skill', 'Skill frontmatter '.repeat(100), 'skill name'),
      ],
      1_000,
      new Set(['Skill']),
    )

    expect(details.map(tool => tool.name)).toEqual(['Read'])
    expect(details[0]!.tokens).toBeLessThan(500)
  })
})

describe('getLoadedDeferredToolNames', () => {
  const deferredTools = [{ name: 'DeferredA' }, { name: 'DeferredB' }] as never

  test('uses tool_reference discovery rather than later tool calls', () => {
    const messages = [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'search',
              content: [
                { type: 'tool_reference', tool_name: 'DeferredA' },
                { type: 'tool_reference', tool_name: 'Unrelated' },
              ],
            },
          ],
        },
      },
    ] as Message[]

    expect([...getLoadedDeferredToolNames(deferredTools, messages)]).toEqual([
      'DeferredA',
    ])
  })

  test('preserves tool_reference discovery across compact boundaries', () => {
    const messages = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: '00000000-0000-0000-0000-000000000000',
        timestamp: new Date().toISOString(),
        compactMetadata: { preCompactDiscoveredTools: ['DeferredB'] },
      },
    ] as Message[]

    expect([...getLoadedDeferredToolNames(deferredTools, messages)]).toEqual([
      'DeferredB',
    ])
  })
})

describe('buildContextUsageData', () => {
  const emptyMessageBreakdown = {
    totalTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: new Map<string, number>(),
    toolResultsByType: new Map<string, number>(),
    attachmentsByType: new Map<string, number>(),
  }

  function build(overrides: Record<string, unknown> = {}) {
    return buildContextUsageData({
      model: 'test-model',
      contextWindow: 200_000,
      autocompactSource: 'auto',
      isAutoCompact: false,
      systemPromptTokens: 0,
      claudeMdTokens: 0,
      builtInToolTokens: 0,
      mcpToolTokens: 0,
      deferredToolTokens: 0,
      deferredBuiltinTokens: 0,
      agentTokens: 0,
      slashCommandTokens: 0,
      skillFrontmatterTokens: 0,
      memoryFileDetails: [],
      mcpToolDetails: [],
      deferredBuiltinDetails: [],
      systemToolDetails: [],
      systemPromptSections: [],
      agentDetails: [],
      commandInfo: { totalCommands: 0, includedCommands: 0 },
      skillInfo: {
        totalSkills: 0,
        includedSkills: 0,
        skillFrontmatter: [],
      },
      messageBreakdown: emptyMessageBreakdown,
      apiUsage: null,
      estimatedTokensAfterLastApiUsage: 0,
      skipReservedBuffer: false,
      ...overrides,
    } as never)
  }

  test('stamps category kinds and boolean deferred/load flags', () => {
    const data = build({
      mcpToolTokens: 40,
      deferredToolTokens: 60,
      mcpToolDetails: [
        { name: 'mcp__one__loaded', serverName: 'one', tokens: 40 },
      ],
    })

    expect(data.categories.every(category => typeof category.isDeferred === 'boolean')).toBe(true)
    expect(data.categories.find(category => category.name === 'MCP tools')?.kind).toBe('used')
    expect(data.categories.find(category => category.name === 'MCP tools (deferred)')).toMatchObject({
      kind: 'deferred',
      isDeferred: true,
    })
    expect(data.categories.find(category => category.name === 'Compact buffer')?.kind).toBe('buffer')
    expect(data.categories.find(category => category.name === 'Free space')?.kind).toBe('free')
    expect(data.mcpTools[0]?.isLoaded).toBe(false)
  })

  test('shows the autocompact buffer only for an explicitly configured window', () => {
    const automatic = build({
      isAutoCompact: true,
      autocompactSource: 'auto',
      autoCompactThreshold: 167_000,
    })
    const configured = build({
      isAutoCompact: true,
      autocompactSource: 'env',
      autoCompactThreshold: 167_000,
    })

    expect(automatic.categories.some(category => category.kind === 'buffer')).toBe(false)
    expect(automatic.autoCompactThreshold).toBe(167_000)
    expect(configured.categories.find(category => category.kind === 'buffer')).toMatchObject({
      name: 'Autocompact buffer',
      tokens: 33_000,
    })
  })

  test('reconciles messages against API usage without clamping totals', () => {
    const data = build({
      systemPromptTokens: 10,
      contextWindow: 100,
      apiUsage: {
        input_tokens: 115,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      estimatedTokensAfterLastApiUsage: 10,
      skipReservedBuffer: true,
    })

    expect(data.categories.find(category => category.name === 'Messages')?.tokens).toBe(90)
    expect(data.totalTokens).toBe(115)
    expect(data.percentage).toBe(115)
    expect(data.categories.find(category => category.name === 'Free space')?.tokens).toBe(0)
  })

  test('keeps locally estimated totals unclamped when API usage is absent', () => {
    const data = build({
      contextWindow: 100,
      messageBreakdown: { ...emptyMessageBreakdown, totalTokens: 125 },
      skipReservedBuffer: true,
    })

    expect(data.categories.find(category => category.name === 'Messages')?.tokens).toBe(125)
    expect(data.totalTokens).toBe(125)
    expect(data.percentage).toBe(125)
    expect(data.categories.find(category => category.name === 'Free space')?.tokens).toBe(0)
  })

  test.each([
    { columns: 0, window: 200_000, rows: 5, width: 5 },
    { columns: 79, window: 200_000, rows: 5, width: 5 },
    { columns: 80, window: 200_000, rows: 10, width: 10 },
    { columns: 0, window: 1_000_000, rows: 10, width: 5 },
    { columns: 80, window: 1_000_000, rows: 10, width: 20 },
  ])('uses the contract grid at $columns columns for a $window window', ({ columns, window, rows, width }) => {
    const data = build({ terminalWidth: columns, contextWindow: window })

    expect(data.gridRows).toHaveLength(rows)
    expect(data.gridRows.every(row => row.length === width)).toBe(true)
  })
})
