import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from './runtime.js'
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
    ).toThrow(/refused: it is the built-in \/diff/)
    expect(() =>
      denied.register(impostor, { name: 'changes', description: 'Alias collision' }),
    ).toThrow(/refused: it is the built-in \/diff/)

    expect(() =>
      denied.register({}, { name: 'h', description: 'Alias collision' }),
    ).toThrow(/refused: it is the built-in \/help/)
    denied.commit(impostor)
    expect(denied.list()).toEqual([])
    expect(denied.projection([diff, help])).toEqual([diff, help])
  })

  test('a replacement policy never permits a built-in alias takeover', () => {
    const diff = command('diff', ['changes'])
    const owner = {}
    const registry = createRegistry({
      getBuiltinCommands: () => [diff],
      canReplaceBuiltin: () => true,
    })
    expect(() => registry.register(owner, { name: 'changes', description: 'Replacement' }))
      .toThrow(/refused: it is the built-in \/diff/)
    registry.commit(owner)
    expect(registry.list()).toEqual([])
    expect(registry.projection([diff])).toEqual([diff])
  })

  test('allows only an explicitly trusted owner to replace the exact built-in command', () => {
    const diff = command('diff', ['changes'])
    const trusted = {}
    const registry = createRegistry({
      getBuiltinCommands: () => [diff],
      canReplaceBuiltin: (owner, _spec, builtin) => owner === trusted && builtin.name === 'diff',
    })
    expect(registry.register(trusted, { name: 'diff', description: 'Official Mod diff' }))
      .toEqual({ command: 'diff' })
    expect(() => registry.register(trusted, { name: 'changes', description: 'Alias takeover' }))
      .toThrow(/refused: it is the built-in \/diff/)
    expect(() => registry.register({}, { name: 'diff', description: 'Spoofed takeover' }))
      .toThrow(/refused: it is the built-in \/diff/)
    registry.commit(trusted)
    expect(registry.projection([diff]).map(item => item.description)).toEqual(['Official Mod diff'])
    registry.release(trusted)
    expect(registry.projection([diff])).toEqual([diff])
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

  test('publishes commands registered after an activation commits with no initial commands', () => {
    const owner = {}
    const registry = createRegistry()
    const initial = registry.getSnapshot()
    const observed: Command[][] = []
    registry.subscribe(() => observed.push(registry.getSnapshot()))

    registry.commit(owner)
    expect(registry.getSnapshot()).toBe(initial)
    expect(observed).toEqual([])
    expect(registry.register(owner, { name: 'late', description: 'Late' })).toEqual({ command: 'late' })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({ name: 'late', description: 'Late' })
    expect(registry.ownerOf(registry.list()[0]!)).toBe(owner)
    expect(observed).toEqual([registry.getSnapshot()])
  })

  test('published registration updates only the named command and leaves old snapshots intact', () => {
    const owner = {}
    const other = {}
    const registry = createRegistry()
    registry.register(owner, { name: 'hello', description: 'First', immediate: true })
    registry.register(owner, { name: 'keep', description: 'Keep' })
    registry.commit(owner)
    registry.register(other, { name: 'other', description: 'Other' })
    registry.commit(other)
    const before = registry.getSnapshot()
    const observed: Command[][] = []
    registry.subscribe(() => observed.push(registry.getSnapshot()))

    registry.register(owner, { name: 'late', description: 'Late' })
    const added = registry.getSnapshot()
    expect(added.map(command => command.name)).toEqual(['hello', 'keep', 'other', 'late'])
    expect(added.slice(0, 3)).toEqual(before)
    const updated: ModCommandSpec = { name: 'hello', description: 'Second', argumentHint: '[new]' }
    registry.register(owner, updated)
    updated.description = 'mutated after registration'
    const replaced = registry.getSnapshot()
    expect(replaced.map(command => command.name)).toEqual(['hello', 'keep', 'other', 'late'])
    expect(replaced[0]).toMatchObject({ description: 'Second', argumentHint: '[new]' })
    expect(replaced[0]?.immediate).toBeUndefined()
    expect(replaced[0]).not.toBe(before[0])
    for (let index = 1; index < replaced.length; index++) expect(replaced[index]).toBe(added[index])
    expect(registry.ownerOf(replaced[0]!)).toBe(owner)
    expect(registry.ownerOf(before[0]!)).toBeUndefined()
    expect(registry.ownerOf(replaced[2]!)).toBe(other)
    expect(before.map(command => command.description)).toEqual(['First', 'Keep', 'Other'])
    expect(added[0]).toBe(before[0])
    expect(Object.isFrozen(before)).toBe(true)
    expect(observed).toEqual([added, replaced])

    registry.release(owner)
    expect(registry.list()).toEqual([before[2]!])
    expect(registry.ownerOf(replaced[0]!)).toBeUndefined()
    expect(replaced).toHaveLength(4)
    expect(observed).toEqual([added, replaced, registry.getSnapshot()])
  })

  test('rejects published registration conflicts without changing snapshots or notifying', () => {
    const builtins = [command('diff', ['changes']), command('help', ['h'])]
    const owner = {}
    const other = {}
    const registry = createRegistry({ getBuiltinCommands: () => builtins })
    registry.register(owner, { name: 'keep', description: 'Keep' })
    registry.commit(owner)
    registry.register(other, { name: 'shared', description: 'Other' })
    registry.commit(other)
    const before = registry.getSnapshot()
    const observed: Command[][] = []
    registry.subscribe(() => observed.push(registry.getSnapshot()))

    expect(() => registry.register(owner, { name: 'shared', description: 'Collision' }))
      .toThrow(/already owned by another activation/)
    for (const builtin of builtins) {
      for (const name of [builtin.name, ...builtin.aliases!]) {
        expect(() => registry.register(owner, { name, description: 'Collision' }))
          .toThrow(`Command /${name} refused: it is the built-in /${builtin.name}`)
      }
    }
    expect(() => registry.register(owner, { name: 'keep', description: ' ' })).toThrow(/description/)
    expect(registry.getSnapshot()).toBe(before)
    expect(registry.ownerOf(before[1]!)).toBe(other)
    expect(observed).toEqual([])
    expect(registry.projection(builtins)).toEqual([...builtins, ...before])

    registry.register(owner, { name: 'keep', description: 'Updated' })
    expect(registry.list()[0]?.description).toBe('Updated')
    expect(registry.list()[1]).toBe(before[1])
    expect(observed).toEqual([registry.getSnapshot()])
  })

  test.each([false, true])('release clears publication and candidates (initial command: %s)', initiallyRegistered => {
    const owner = {}
    const registry = createRegistry()
    if (initiallyRegistered) registry.register(owner, { name: 'initial', description: 'Initial' })
    registry.commit(owner)
    registry.release(owner)
    const empty = registry.getSnapshot()
    expect(empty).toEqual([])
    const observed: Command[][] = []
    registry.subscribe(() => observed.push(registry.getSnapshot()))

    registry.register(owner, { name: 'stale', description: 'Stale' })
    expect(registry.getSnapshot()).toBe(empty)
    registry.release(owner)
    registry.commit(owner)
    expect(registry.getSnapshot()).toBe(empty)
    expect(observed).toEqual([])
    registry.register(owner, { name: 'fresh', description: 'Fresh' })
    expect(registry.list().map(command => command.name)).toEqual(['fresh'])
    expect(observed).toEqual([registry.getSnapshot()])
  })

  test.each([false, true])('replacement clears the old publication (initial command: %s)', initiallyRegistered => {
    const oldOwner = {}
    const replacement = {}
    const registry = createRegistry()
    if (initiallyRegistered) registry.register(oldOwner, { name: 'old', description: 'Old' })
    registry.commit(oldOwner)
    registry.commit(replacement, oldOwner)
    const empty = registry.getSnapshot()
    expect(empty).toEqual([])
    const observed: Command[][] = []
    registry.subscribe(() => observed.push(registry.getSnapshot()))

    registry.register(oldOwner, { name: 'stale', description: 'Stale' })
    expect(registry.getSnapshot()).toBe(empty)
    registry.release(oldOwner)
    expect(observed).toEqual([])
    registry.register(replacement, { name: 'new', description: 'New' })
    expect(registry.list().map(command => command.name)).toEqual(['new'])
    expect(registry.ownerOf(registry.list()[0]!)).toBe(replacement)
    expect(observed).toEqual([registry.getSnapshot()])
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
  test('lists real Worker command.describe answers through the shared projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-command-describe-'))
    const entry = join(root, 'register.ts')
    const builtin = { ...command('sample'), argumentHint: '[old]', immediate: true }
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({
      services: { commands: () => [builtin] },
      onDiagnostic: event => diagnostics.push(event),
    })
    try {
      await writeFile(entry, `export function register(on) {
        on('command.describe', {command:'sample'}, async ($, e, next) => {
          if (e.description !== 'Built-in sample' || e.argumentHint !== '[old]' ||
              e.isHidden !== false || e.immediate !== true ||
              e.provider.plugin !== 'engine' || e.provider.tier !== 'core' ||
              next.origin.plugin !== 'engine' || next.origin.tier !== 'core') throw Error('bad describe shape');
          const result = await next({...e, description:'Worker description', argumentHint:'[new]', isHidden:true});
          if (Object.keys(result).sort().join(',') !== 'argumentHint,description,isHidden') throw Error('bad result shape');
          return result;
        });
        on('tool.call', async $ => ({result:await $.command.list()}));
      }`)
      await runtime.reconcile([{ name: 'describe', storageId: 'describe@test', pluginRoot: root, entrypoints: [entry] }])
      expect(diagnostics).toEqual([])
      expect(await runtime.dispatch('tool.call', {}, async () => ({ result: 'core' }))).toEqual({
        result: [{ name: 'sample', description: 'Worker description', source: 'builtin' }],
      })
      const projected = runtime.commands.projection([builtin])[0]!
      expect(projected).toMatchObject({
        name: 'sample', description: 'Worker description', argumentHint: '[new]', isHidden: true, immediate: true,
      })
      expect(projected.userFacingName).toBe(builtin.userFacingName)
      if (!('load' in projected) || !('load' in builtin)) throw new Error('Expected local command')
      expect(projected.load).toBe(builtin.load)
      expect(builtin.description).toBe('Built-in sample')
      expect(diagnostics).toEqual([])
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rotates Worker description cache on hook reload and session change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-command-lifecycle-'))
    const entry = join(root, 'register.ts')
    const builtin = command('sample')
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event) })
    const plugin = { name: 'lifecycle', storageId: 'lifecycle@test', pluginRoot: root, entrypoints: [entry] }
    const binding = { cwd: root, surface: 'terminal' as const, isInteractive: true, sessionId: 'first' }
    try {
      const source = (label: string) => `let calls=0; export function register(on) {
        on('command.describe', ($,e,next) => next({...e,description:'${label} '+(++calls)}));
      }`
      await writeFile(entry, source('old'))
      await runtime.bind(binding)
      await runtime.reconcile([plugin])
      expect(diagnostics).toEqual([])
      expect((await runtime.commands.describe([builtin]))[0]?.description).toBe('old 1')
      expect((await runtime.commands.describe([builtin]))[0]?.description).toBe('old 1')
      await writeFile(entry, source('new'))
      await runtime.reconcile([plugin])
      expect((await runtime.commands.describe([builtin]))[0]?.description).toBe('new 1')
      await runtime.bind({ ...binding, sessionId: 'second' })
      expect((await runtime.commands.describe([builtin]))[0]?.description).toBe('new 2')
      await runtime.reconcile([])
      expect((await runtime.commands.describe([builtin]))[0]?.description).toBe('Built-in sample')
      expect(diagnostics).toEqual([])
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves providers, origins, ownership and dynamic immediate while failing invalid hooks through', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-command-contract-'))
    const entry = join(root, 'register.ts')
    const immediate = () => true
    const skill = {
      type: 'prompt', name: 'pack:skill', source: 'plugin', loadedFrom: 'plugin',
      description: 'Skill', immediate, progressMessage: 'Working', contentLength: 0,
      pluginInfo: { pluginManifest: { name: 'pack' }, repository: 'pack@test' },
      getPromptForCommand: async () => [],
    } as Command
    const invalid = ['command', 'immediate', 'provider', 'argumentHint', 'result', 'throw'].map(name => command(name))
    const diagnostics: { stage: string; message: string }[] = []
    const runtime = createModsRuntime({
      services: { pluginOrigin: id => id === 'pack@test' ? { plugin: id, tier: 'append' } : undefined },
      onDiagnostic: event => diagnostics.push(event),
    })
    try {
      await writeFile(entry, `export function register(on) {
        on('session.start', async ($,e,next) => {await $.command.register({name:'owned',description:'Owned',immediate:true});return next(e)});
        on('command.describe', ($,e,next) => {
          if(next.origin.plugin!=='engine'||next.origin.tier!=='core') throw Error('bad origin');
          if(e.command==='owned') return {description:JSON.stringify(e.provider),isHidden:false};
          if(e.command==='pack:skill') return {description:JSON.stringify({provider:e.provider,immediate:e.immediate}),isHidden:false};
          if(e.command==='command') return next({...e,command:'other'});
          if(e.command==='immediate') return next({...e,immediate:true});
          if(e.command==='provider') return next({...e,provider:{plugin:'forged',tier:'core'}});
          if(e.command==='argumentHint') return next({...e,argumentHint:17});
          if(e.command==='result') return {description:'bad',argumentHint:17,isHidden:false};
          throw Error('failed describe');
        });
      }`)
      await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'contract' })
      await runtime.reconcile([{ name: 'owner', storageId: 'owner@test', tier: 'prepend', pluginRoot: root, entrypoints: [entry] }])
      expect(diagnostics).toEqual([])
      const originals = runtime.commands.list()
      const projected = await runtime.commands.describe([skill, ...invalid])
      expect(JSON.parse(projected[0]!.description)).toEqual({ provider: { plugin: 'pack@test', tier: 'append' }, immediate: false })
      expect(projected[0]!.immediate).toBe(immediate)
      const owned = projected.at(-1)!
      expect(JSON.parse(owned.description)).toEqual({ plugin: 'owner@test', tier: 'prepend' })
      expect(owned.immediate).toBe(true)
      expect(isModCommand(owned)).toBe(true)
      expect(runtime.commands.ownerOf(owned)).toBe(runtime.commands.ownerOf(originals[0]!))
      expect(projected.slice(1, -1).map(cmd => cmd.description)).toEqual(invalid.map(cmd => cmd.description))
      expect(diagnostics).toHaveLength(invalid.length)
      expect(diagnostics.every(event => event.stage === 'command.describe')).toBe(true)
      const again = await runtime.commands.describe(projected)
      expect(again).toEqual(projected)
      expect(diagnostics).toHaveLength(invalid.length)
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('coalesces pending reads and never publishes a completion from an invalidated cache', async () => {
    const first = Promise.withResolvers<{ description: string; isHidden: boolean }>()
    const second = Promise.withResolvers<{ description: string; isHidden: boolean }>()
    let calls = 0
    const registry = createRegistry({ describe: async () => ++calls === 1 ? first.promise : second.promise })
    const base = [command('pending')]
    const reads = [registry.describe(base), registry.describe(base)]
    expect(calls).toBe(1)
    registry.invalidateDescriptions()
    const fresh = registry.describe(base)
    expect(calls).toBe(2)
    second.resolve({ description: 'fresh', isHidden: false })
    const projected = await fresh
    const published = registry.getSnapshot()
    first.resolve({ description: 'stale', isHidden: true })
    await Promise.all(reads)
    expect(registry.getSnapshot()).toBe(published)
    expect(registry.projection(projected)[0]?.description).toBe('fresh')
    expect((await registry.describe(projected))[0]?.description).toBe('fresh')
    expect(calls).toBe(2)
  })

  test('does not resurrect released Mod commands from a help projection captured before release', async () => {
    const registry = createRegistry({ describe: async command => ({ description: command.description, isHidden: false }) })
    const owner = {}
    registry.register(owner, { name: 'temporary', description: 'Temporary' })
    registry.commit(owner)
    const before = await registry.describe([])
    registry.release(owner)
    expect(registry.projection(before)).toEqual([])
  })

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
