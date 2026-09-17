import { describe, expect, test } from 'bun:test'
import type { Command, LocalJSXCommandContext } from '../../types/command.js'
import type { SlashCommandResult } from '../../utils/processUserInput/processSlashCommand.js'
import { runModCommand } from './commandAdapter.js'
import {
  createModCommands,
  isModCommand,
  type ModCommandSpec,
} from './commands.js'
import { dispatchModEvent } from './dispatch.js'
import type { ModSnapshot } from './runtime.js'
import type { ModDispatchHook } from './types.js'

function command(name: string, aliases?: string[]): Command {
  return {
    type: 'local-jsx',
    name,
    aliases,
    description: `Built-in ${name}`,
    load: async () => ({ call: async () => null }),
  }
}

function createRegistry(options: Partial<Parameters<typeof createModCommands>[0]> = {}) {
  return createModCommands({
    getBuiltinCommands: () => [],
    run: async () => ({}),
    ...options,
  })
}

function snapshot(...handlers: ModDispatchHook['invoke'][]): ModSnapshot {
  return {
    hasHooks: () => handlers.length > 0,
    release() {},
    dispatch: (event, input, core, options) =>
      dispatchModEvent({
        event,
        input,
        core,
        ...options,
        hooks: handlers.map((invoke, index) => ({
          plugin: `test-${index}`,
          tier: 'user',
          registration: {
            id: index + 1,
            event,
            hasCatch: false,
          },
          invoke,
        })),
      }),
  }
}

describe('mod command ownership', () => {
  test('requires a description with non-whitespace text and preserves valid multiline descriptions', () => {
    const owner = {}
    const registry = createRegistry()
    for (const description of ['', ' ', '\t', '\r\n']) {
      expect(() => registry.register(owner, { name: 'invalid', description })).toThrow(/description/)
    }
    const description = 'First line\nSecond line'
    registry.register(owner, { name: 'valid', description })
    registry.commit(owner)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.description).toBe(description)
  })

  test('rejects built-in names and aliases regardless of plugin identity', () => {
    const diff = command('diff', ['changes'])
    const help = command('help', ['h'])
    const impostor = { pluginName: 'diff', isNative: true }
    const denied = createRegistry({ getBuiltinCommands: () => [diff, help] })

    expect(() =>
      denied.register(impostor, { name: 'diff', description: 'Replacement' }),
    ).toThrow(/built-in.*diff/i)
    expect(() =>
      denied.register(impostor, { name: 'changes', description: 'Alias collision' }),
    ).toThrow(/built-in.*diff/i)

    expect(() =>
      denied.register({}, { name: 'h', description: 'Alias collision' }),
    ).toThrow(/built-in.*help/i)
    denied.commit(impostor)
    expect(denied.list()).toEqual([])
    expect(denied.projection([diff, help])).toEqual([diff, help])
  })

  test('only an explicitly approved owner can replace the exact builtin and its aliases', () => {
    const diff = command('diff', ['changes'])
    const help = command('help', ['h'])
    const owner = {}
    const registry = createRegistry({
      getBuiltinCommands: () => [diff, help],
      allowBuiltinConflict: conflict => conflict.owner === owner && conflict.builtin === diff && conflict.spec.name === 'diff',
    })
    expect(() => registry.register({}, {name:'diff',description:'Impostor'})).toThrow(/conflicts/)
    expect(() => registry.register(owner, {name:'h',description:'Not approved'})).toThrow(/conflicts/)
    registry.register(owner, {name:'diff',description:'Approved'})
    expect(registry.projection([diff,help])).toEqual([diff,help])
    registry.commit(owner)
    expect(registry.projection([diff,help]).map(item => item.name)).toEqual(['help','diff'])
    registry.release(owner)
    expect(registry.projection([diff,help])).toEqual([diff,help])
  })

  test('repeated registration by one activation replaces its candidate spec', () => {
    const owner = {}
    const registry = createRegistry()
    const first: ModCommandSpec = {
      name: 'hello',
      description: 'First',
      argumentHint: '[old]',
    }
    registry.register(owner, first)
    registry.register(owner, {
      name: 'hello',
      description: 'Second',
      argumentHint: '[new]',
      immediate: true,
    })
    first.description = 'mutated after registration'

    expect(registry.list()).toEqual([])
    registry.commit(owner)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({
      name: 'hello',
      description: 'Second',
      argumentHint: '[new]',
      immediate: true,
      type: 'local-jsx',
    })
  })

  test('keeps the old activation visible through reload rollback, then swaps atomically by owner identity', () => {
    const oldOwner = { pluginName: 'same-plugin' }
    const failedCandidate = { pluginName: 'same-plugin' }
    const readyCandidate = { pluginName: 'same-plugin' }
    const registry = createRegistry()

    registry.register(oldOwner, { name: 'hello', description: 'old' })
    registry.commit(oldOwner)
    const oldCommand = registry.list()[0]
    const oldSnapshot = registry.getSnapshot()

    registry.register(failedCandidate, { name: 'hello', description: 'failed' })
    expect(registry.getSnapshot()).toBe(oldSnapshot)
    expect(registry.list()[0]).toBe(oldCommand)
    registry.release(failedCandidate)
    expect(registry.getSnapshot()).toBe(oldSnapshot)
    expect(registry.list()[0]).toBe(oldCommand)

    registry.register(readyCandidate, { name: 'hello', description: 'ready' })
    expect(registry.list()[0]).toBe(oldCommand)
    registry.commit(readyCandidate, oldOwner)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ name: 'hello', description: 'ready' })
    expect(registry.list()[0]).not.toBe(oldCommand)

    registry.release(oldOwner)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.description).toBe('ready')
    registry.release(readyCandidate)
    expect(registry.list()).toEqual([])
  })

  test('does not let an unrelated candidate shadow an active owner at commit', () => {
    const active = {}
    const candidate = {}
    const registry = createRegistry()
    registry.register(active, { name: 'same', description: 'active' })
    registry.commit(active)
    const before = registry.getSnapshot()

    registry.register(candidate, { name: 'same', description: 'candidate' })
    expect(() => registry.commit(candidate)).toThrow(/already owned/i)
    expect(registry.getSnapshot()).toBe(before)
    expect(registry.list()[0]?.description).toBe('active')
  })
})

describe('mod command projection', () => {
  test('replaces colliding non-built-in commands while preserving unrelated order', () => {
    const owner = {}
    const registry = createRegistry()
    const first = command('first')
    const stale = command('stale', ['dynamic'])
    registry.register(owner, { name: 'dynamic', description: 'dynamic' })
    registry.commit(owner)

    const projected = registry.projection([first, stale])
    expect(projected.map(value => value.name)).toEqual(['first', 'dynamic'])
    expect(projected[0]).toBe(first)
    expect(isModCommand(projected[1]!)).toBe(true)
  })

  test('publishes stable snapshots and notifies only committed projection changes', () => {
    const owner = {}
    const registry = createRegistry()
    const initial = registry.getSnapshot()
    const observed: (readonly Command[])[] = []
    const unsubscribe = registry.subscribe(() => observed.push(registry.getSnapshot()))

    expect(registry.getSnapshot()).toBe(initial)
    registry.register(owner, { name: 'one', description: 'one' })
    expect(registry.getSnapshot()).toBe(initial)
    expect(observed).toEqual([])

    registry.commit(owner)
    const committed = registry.getSnapshot()
    expect(committed).not.toBe(initial)
    expect(registry.getSnapshot()).toBe(committed)
    expect(registry.list()).toBe(committed)
    expect(observed).toEqual([committed])

    registry.release({})
    expect(registry.getSnapshot()).toBe(committed)
    expect(observed).toEqual([committed])

    unsubscribe()
    registry.release(owner)
    expect(registry.getSnapshot()).not.toBe(committed)
    expect(observed).toEqual([committed])
  })

  test('passes immediate through and calls onDone only after the real run without rendering a pane', async () => {
    const owner = {}
    let finish!: (result: { text?: string }) => void
    const running = new Promise<{ text?: string }>(resolve => {
      finish = resolve
    })
    const calls: string[] = []
    const context = { marker: 'context' } as unknown as LocalJSXCommandContext
    const registry = createRegistry({
      run: async (name, args, receivedContext) => {
        calls.push(`run:${name}:${args}`)
        expect(receivedContext).toBe(context)
        return running
      },
    })
    registry.register(owner, {
      name: 'now',
      description: 'Run now',
      immediate: true,
    })
    registry.commit(owner)

    const projected = registry.list()[0]!
    expect(projected.immediate).toBe(true)
    if (projected.type !== 'local-jsx') throw new Error('Expected a JSX command')
    const module = await projected.load()
    const invocation = module.call(
      text => calls.push(`done:${text}`),
      context,
      'arg value',
    )
    await Promise.resolve()
    expect(calls).toEqual(['run:now:arg value'])

    finish({ text: 'complete' })
    expect(await invocation).toBeNull()
    expect(calls).toEqual(['run:now:arg value', 'done:complete'])
  })

  test('completes textless runs with display skip and still returns no pane', async () => {
    const owner = {}
    const registry = createRegistry({ run: async () => ({}) })
    registry.register(owner, { name: 'quiet', description: 'quiet' })
    registry.commit(owner)
    const projected = registry.list()[0]!
    if (projected.type !== 'local-jsx') throw new Error('Expected a JSX command')
    const module = await projected.load()
    const done: unknown[][] = []

    expect(
      await module.call((...args) => done.push(args), {} as LocalJSXCommandContext, ''),
    ).toBeNull()
    expect(done).toEqual([[undefined, { display: 'skip' }]])
  })

  test('dispatches one command.run middleware chain through the real adapter', async () => {
    const owner = {}
    let middlewareCalls = 0
    let coreCalls = 0
    const modSnapshot = snapshot(async (input, next) => {
      middlewareCalls++
      return next({ ...input, args: `${input.args}-rewritten` })
    })
    const registry = createRegistry({
      run: async (canonical, args) => {
        const projected = registry.list()[0]!
        const result = await runModCommand({
          snapshot: modSnapshot,
          input: {
            command: canonical,
            args,
            origin: { kind: 'composer' },
            presentation: { isFullscreen: false, columns: 80 },
          },
          command: projected,
          core: async rewrittenArgs => {
            coreCalls++
            expect(rewrittenArgs).toBe('original-rewritten')
            return {
              command: projected,
              messages: [],
              shouldQuery: false,
              resultText: 'adapter result',
            } satisfies SlashCommandResult
          },
        })
        return { text: result.resultText }
      },
    })
    registry.register(owner, { name: 'once', description: 'once' })
    registry.commit(owner)
    const projected = registry.list()[0]!
    if (projected.type !== 'local-jsx') throw new Error('Expected a JSX command')
    const module = await projected.load()
    const done: (string | undefined)[] = []

    expect(
      await module.call(text => done.push(text), {} as LocalJSXCommandContext, 'original'),
    ).toBeNull()
    expect(middlewareCalls).toBe(1)
    expect(coreCalls).toBe(1)
    expect(done).toEqual(['adapter result'])
  })
})
