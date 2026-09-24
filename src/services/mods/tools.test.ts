import { describe, expect, test } from 'bun:test'
import type { Tool } from '../../Tool.js'
import { createModTools } from './tools.js'

function createRegistry(
  options: Partial<Parameters<typeof createModTools>[0]> = {},
) {
  return createModTools({
    pluginOf: () => 'weather',
    getBuiltinTools: () => [],
    ...options,
  })
}

function baseTool(name: string, aliases?: string[]): Tool {
  return { name, aliases } as Tool
}

describe('mod tool ownership', () => {
  test('publishes a registered tool with its real schema and no core implementation', async () => {
    const owner = {}
    const registry = createRegistry()

    expect(
      registry.register(owner, {
        name: 'forecast',
        description: 'Gets a forecast.',
      }),
    ).toEqual({ tool: 'mcp__weather__forecast' })
    expect(registry.list()).toEqual([])

    registry.commit(owner)
    const tool = registry.list()[0]!
    expect(tool.name).toBe('mcp__weather__forecast')
    expect(tool.isMcp).toBe(true)
    expect(tool.mcpInfo).toBeUndefined()
    expect(tool.inputJSONSchema).toEqual({ type: 'object' })
    expect(tool.inputSchema.safeParse({}).success).toBe(true)
    expect(await tool.description({}, {} as never)).toBe('Gets a forecast.')
    expect(
      tool.mapToolResultToToolResultBlockParam({ temperature: 21 }, 'call-1'),
    ).toEqual({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content: '{"temperature":21}',
    })
    await expect(
      tool.call({} as never, {} as never, (() => {}) as never, {} as never),
    ).rejects.toThrow(/must be answered by a Mods tool\.call hook/)
    expect(registry.ownerOf(tool)).toBe(owner)
  })

  test('uses owner plugin names in canonical names and refuses base-tool collisions', () => {
    const first = {}
    const second = {}
    const builtIn = baseTool('mcp__first__taken', ['mcp__first__alias'])
    const registry = createRegistry({
      pluginOf: owner => (owner === first ? 'first' : 'second'),
      getBuiltinTools: () => [builtIn],
    })

    expect(() =>
      registry.register(first, { name: 'taken', description: 'Taken' }),
    ).toThrow(/built-in/)
    expect(() =>
      registry.register(first, { name: 'alias', description: 'Alias' }),
    ).toThrow(/built-in/)
    expect(
      registry.register(second, { name: 'taken', description: 'Allowed' }),
    ).toEqual({ tool: 'mcp__second__taken' })
    registry.commit(second)
    expect(registry.list().map(tool => tool.name)).toEqual([
      'mcp__second__taken',
    ])

    const normalizedOwner = {}
    const normalized = createRegistry({ pluginOf: () => 'plugin.name' })
    expect(
      normalized.register(normalizedOwner, {
        name: 'tool',
        description: 'Tool',
      }),
    ).toEqual({ tool: 'mcp__plugin_name__tool' })
  })

  test('supports getTools as the base collision source', () => {
    const owner = {}
    const existing = baseTool('mcp__weather__existing')
    const registry = createModTools({
      pluginOf: () => 'weather',
      getTools: () => [existing],
    })

    expect(() =>
      registry.register(owner, { name: 'existing', description: 'Existing' }),
    ).toThrow(/built-in/)
  })

  test('strictly validates and snapshots ToolSpec including its JSON schema', async () => {
    const owner = {}
    const registry = createRegistry()

    for (const name of ['', 'bad name', 'a'.repeat(65)])
      expect(() =>
        registry.register(owner, { name, description: 'Valid' }),
      ).toThrow(/name/)
    for (const description of ['', ' ', '\t', '\r\n'])
      expect(() =>
        registry.register(owner, { name: 'valid', description }),
      ).toThrow(/description/)
    for (const inputSchema of [null, [], 'object', { type: 'array' }])
      expect(() =>
        registry.register(owner, {
          name: 'valid',
          description: 'Valid',
          inputSchema: inputSchema as never,
        }),
      ).toThrow(/inputSchema/)
    expect(() =>
      registry.register(owner, {
        name: 'valid',
        description: 'Valid',
        inputSchema: { type: 'object', required: 'value' },
      }),
    ).toThrow(/inputSchema/)

    const spec = {
      name: 'lookup',
      description: 'Looks up a value.\nReturns its record.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
        additionalProperties: false,
      },
    }
    registry.register(owner, spec)
    spec.description = 'mutated'
    spec.inputSchema.properties.id.type = 'string'
    registry.commit(owner)

    const tool = registry.list()[0]!
    expect(tool.inputJSONSchema).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    })
    expect(tool.inputSchema.safeParse({ id: 1 }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ id: '1' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ id: 1, extra: true }).success).toBe(false)

    const unicodeOwner = {}
    const unicode = createRegistry()
    unicode.register(unicodeOwner, {
      name: 'unicode',
      description: 'before\uD800after',
    })
    unicode.commit(unicodeOwner)
    expect(
      await unicode.list()[0]!.description({}, {} as never),
    ).toBe('before\uFFFDafter')
  })

  test('detects cross-owner conflicts at publication and across prepared owners', () => {
    const first = {}
    const second = {}
    const third = {}
    const registry = createRegistry()
    registry.register(first, { name: 'shared', description: 'First' })
    registry.commit(first)
    const before = registry.getSnapshot()

    registry.register(second, { name: 'shared', description: 'Second' })
    expect(() => registry.validateCommit(second)).toThrow(/already owned/)
    expect(() => registry.commit(second)).toThrow(/already owned/)
    expect(registry.getSnapshot()).toBe(before)
    expect(registry.ownerOf(before[0]!)).toBe(first)

    registry.release(second)
    registry.register(second, { name: 'prepared', description: 'Second' })
    registry.register(third, { name: 'prepared', description: 'Third' })
    expect(() => registry.validateCommit(third, undefined, [second])).toThrow(
      /already owned/,
    )
    expect(registry.getSnapshot()).toBe(before)
  })

  test('validates replacement pairs without letting retired owners delete a new generation', async () => {
    const oldOwner = {}
    const replacement = {}
    const unrelated = {}
    const registry = createRegistry()
    registry.register(oldOwner, { name: 'shared', description: 'Old' })
    registry.commit(oldOwner)
    registry.register(replacement, { name: 'shared', description: 'New' })

    expect(() => registry.validateCommit(replacement, unrelated)).toThrow(
      /already owned/,
    )
    registry.validateCommit(replacement, oldOwner)
    registry.commit(replacement, oldOwner)
    const current = registry.list()[0]!

    registry.release(oldOwner)
    expect(registry.list()).toEqual([current])
    expect(registry.ownerOf(current)).toBe(replacement)
  })

  test('keeps the old generation through rollback and replacement retirement', async () => {
    const oldOwner = {}
    const failed = {}
    const replacement = {}
    const registry = createRegistry()
    registry.register(oldOwner, { name: 'shared', description: 'Old' })
    registry.register(oldOwner, { name: 'retired', description: 'Retired' })
    registry.commit(oldOwner)
    const oldSnapshot = registry.getSnapshot()
    const oldShared = oldSnapshot[0]!

    registry.register(failed, { name: 'shared', description: 'Failed' })
    expect(registry.getSnapshot()).toBe(oldSnapshot)
    registry.release(failed)
    expect(registry.getSnapshot()).toBe(oldSnapshot)
    expect(registry.ownerOf(oldShared)).toBe(oldOwner)

    registry.register(replacement, { name: 'shared', description: 'New' })
    registry.validateCommit(replacement, oldOwner)
    registry.commit(replacement, oldOwner)
    const next = registry.getSnapshot()
    expect(next).toHaveLength(1)
    expect(next[0]!.name).toBe('mcp__weather__shared')
    expect(await next[0]!.description({}, {} as never)).toBe('New')
    expect(registry.ownerOf(next[0]!)).toBe(replacement)
    expect(registry.ownerOf(oldShared)).toBeUndefined()

    registry.release(oldOwner)
    expect(registry.getSnapshot()).toBe(next)
    expect(registry.ownerOf(next[0]!)).toBe(replacement)
    registry.release(replacement)
    expect(registry.list()).toEqual([])
  })

  test('projects active tools over colliding base names and aliases', () => {
    const owner = {}
    const registry = createRegistry()
    const first = baseTool('First')
    const stale = baseTool('Stale', ['mcp__weather__active'])
    const unrelated = baseTool('Unrelated')

    expect(registry.projection([first, stale, unrelated])).toEqual([
      first,
      stale,
      unrelated,
    ])
    registry.register(owner, { name: 'active', description: 'Active' })
    expect(registry.projection([first, stale, unrelated])).toEqual([
      first,
      stale,
      unrelated,
    ])
    registry.commit(owner)

    const projected = registry.projection([first, stale, unrelated])
    expect(projected.map(tool => tool.name)).toEqual([
      'First',
      'Unrelated',
      'mcp__weather__active',
    ])
    expect(projected[0]).toBe(first)
    expect(projected[1]).toBe(unrelated)
    expect(projected[2]).toBe(registry.list()[0])
  })

  test.each([false, true])(
    'release clears publication and unpublished candidates (initial tool: %s)',
    initiallyRegistered => {
      const owner = {}
      const registry = createRegistry()
      if (initiallyRegistered)
        registry.register(owner, { name: 'initial', description: 'Initial' })
      registry.commit(owner)
      registry.release(owner)
      const empty = registry.getSnapshot()
      expect(empty).toEqual([])
      const observed: (readonly Tool[])[] = []
      registry.subscribe(() => {
        observed.push(registry.getSnapshot())
      })

      registry.register(owner, { name: 'stale', description: 'Stale' })
      expect(registry.getSnapshot()).toBe(empty)
      registry.release(owner)
      registry.commit(owner)
      expect(registry.getSnapshot()).toBe(empty)
      expect(observed).toEqual([])
      registry.register(owner, { name: 'fresh', description: 'Fresh' })
      expect(registry.list().map(tool => tool.name)).toEqual([
        'mcp__weather__fresh',
      ])
      expect(observed).toEqual([registry.getSnapshot()])
    },
  )

  test('same-owner registration replaces candidates and published tools in place', async () => {
    const owner = {}
    const registry = createRegistry()
    registry.register(owner, { name: 'one', description: 'First' })
    registry.register(owner, { name: 'keep', description: 'Keep' })
    registry.register(owner, { name: 'one', description: 'Second' })
    registry.commit(owner)

    expect(registry.list().map(tool => tool.name)).toEqual([
      'mcp__weather__one',
      'mcp__weather__keep',
    ])
    expect(await registry.list()[0]!.description({}, {} as never)).toBe('Second')
    const before = registry.getSnapshot()
    const observed: (readonly Tool[])[] = []
    registry.subscribe(() => observed.push(registry.getSnapshot()))

    registry.register(owner, { name: 'one', description: 'Third' })
    const after = registry.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.map(tool => tool.name)).toEqual(before.map(tool => tool.name))
    expect(after[0]).not.toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(await after[0]!.description({}, {} as never)).toBe('Third')
    expect(registry.ownerOf(before[0]!)).toBeUndefined()
    expect(registry.ownerOf(after[0]!)).toBe(owner)
    expect(Object.isFrozen(before)).toBe(true)
    expect(observed).toEqual([after])
  })
})
