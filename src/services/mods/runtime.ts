import { AsyncLocalStorage } from 'node:async_hooks'
import { isDeepStrictEqual } from 'node:util'
import type { Tool } from '../../Tool.js'
import { createToolCatalogForContext, type ToolCatalog } from './toolCatalog.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { createModClockBridge, createModEnvironmentHost, createModStoreBridge, createModUiBridge, type ModEnvironment } from './environment.js'
import { createModUi, type ModUiOpenArgs, type ModUiOrigin, type ModUiPresentation } from './ui.js'
import { loadModDeclaration } from './loader.js'
import { getNativeModDeclaration } from './native.js'
import { matchesModEventPattern } from './matcher.js'
import { createModHostOperations, type ModHttpServices } from './hostOperations.js'
import { createModCommands, type ModCommandSpec } from './commands.js'
import { runModCommand, type CommandPresentation } from './commandAdapter.js'
import { getCommandName, type Command } from '../../types/command.js'
import { validateModRenderTree } from '../../components/ModsPane.js'
import { dispatchModEvent } from './dispatch.js'
import { findCanonicalGitRootFresh, getOriginRemoteUrlFresh } from '../../utils/git.js'
import {
  applyPromptFill,
  emptyPromptBox,
  validatePromptBox,
  validatePromptFillInput,
  type ModPromptHost,
  type PromptFillInput,
} from './promptAdapter.js'
import type { ModDeclaration, ModDispatchHook, ModInput, ModNext, ModOrigin, ModTier } from './types.js'

export type ModPluginInput = {
  name: string
  storageId: string
  version?: string
  /** Set only by a trusted host registration, not by plugin.json or tier. */
  isNative?: boolean
  pluginRoot: string
  entrypoints: string[]
  options?: ModInput
  tier?: ModTier
}
export type ModBinding = {
  cwd: string
  surface: 'terminal' | null
  isInteractive: boolean
  sessionId: string
}
export type ModRequestServices = {
  toolCatalog?(): ToolCatalog
}
export type ModHostServices = ModRequestServices & ModHttpServices & {
  pluginOrigin?(storageId: string): ModOrigin | undefined
  cwd?(): string
  root?(): string
  messages?(): readonly unknown[]
  commands?(): readonly Command[]
  builtinCommands?(): readonly Command[]
  presentation?(): CommandPresentation
  uiPresentation?(): ModUiPresentation
  uiLog?(plugin: string, text: string, to: 'transcript' | 'debug'): void
  uiStatus?(plugin: string, text: string | undefined): void
  prompt?(): ModPromptHost | undefined
}
export type ModDiagnostic = { plugin: string; stage: string; message: string }
export type ModDispatchOptions = {
  /** Host-pinned caller identity, never read from the event's input. */
  origin?: ModOrigin
  signal?: AbortSignal
  validateResult?: (value: unknown, nextResults: readonly unknown[]) => void
  validateInput?: (input: ModInput, received: ModInput) => void
  restoreInput?: (input: ModInput, received: ModInput) => ModInput
}
export type ModSnapshot = {
  readonly toolDescriptions?: WeakMap<Tool, Map<string, Promise<string>>>
  pluginOrigin?(storageId: string): ModOrigin | undefined
  dispatch(event: string, input: ModInput, core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>, options?: ModDispatchOptions): Promise<unknown>
  hasHooks(event: string): boolean
  release(): void
}
type Nouns = Record<string, Record<string, (...args: unknown[]) => unknown>>
type InterfaceState = {
  owners: Map<string, string>
  withheld: Map<string, Set<string>>
  carried?: Map<string, Set<string>>
  endedBy?: string
}
type CapabilityLease = { entries: number; building?: boolean }
type Activation = {
  declaration: ModDeclaration
  environment: ModEnvironment
  state: 'candidate' | 'active' | 'retiring' | 'disposed'
  references: number
  started: boolean
  waits: Map<number, { kind: string; timer: ReturnType<typeof setTimeout>; reject(error: Error): void }>
  methods: WeakMap<object, (...args: unknown[]) => Promise<unknown>>
  controller: AbortController
  operations: ReturnType<typeof createModHostOperations>
  uiPublished?: boolean
  uiStatus?: { text: string | undefined }
  uiLogs?: { text: string; to: 'transcript' | 'debug' }[]
  uiRelease?: Promise<void>
  dispose?: Promise<void>
}
type DrawingLease = {
  owner: Activation
  snapshot: readonly Activation[]
  table: Nouns
  participants: Set<Activation>
}
const tierOrder: ModTier[] = ['prepend', 'user', 'append', 'builtin', 'core']
// Identity-only entries; all calls, including beneath, use engineFor's bridge.
const clockIdentity = () => { throw new Error('Clock calls must use the environment bridge') }
const coreClock = Object.freeze({
  now: clockIdentity, sleep: clockIdentity, after: clockIdentity, every: clockIdentity,
})

// Core noun identity is stable; the caller's activation selects its store and lifetime.
const hostIdentity = () => { throw new Error('Host calls must use the environment bridge') }
const coreHost: Nouns = {
  plugin: { name: hostIdentity, root: hostIdentity },
  fs: { read: hostIdentity, write: hostIdentity, list: hostIdentity, exists: hostIdentity, stat: hostIdentity, ancestors: hostIdentity },
  process: { run: hostIdentity },
  settings: { read: hostIdentity },
  env: { get: hostIdentity, set: hostIdentity },
  store: { get: hostIdentity, set: hostIdentity, delete: hostIdentity, keys: hostIdentity },
  session: { cwd: hostIdentity, root: hostIdentity, id: hostIdentity, repo: hostIdentity, surface: hostIdentity, messages: hostIdentity, authorize: hostIdentity },
  http: { fetch: hostIdentity },
  command: { register: hostIdentity, list: hostIdentity },
  tool: { list: hostIdentity },
  prompt: { read: hostIdentity, fill: hostIdentity },
  ui: { open: hostIdentity, close: hostIdentity, scroll: hostIdentity, focus: hostIdentity, invalidate: hostIdentity, log: hostIdentity, status: hostIdentity, resolve: hostIdentity },
}

export function createModsRuntime({ onDiagnostic, services = {} }: {
  onDiagnostic?: (event: ModDiagnostic) => void
  services?: ModHostServices
} = {}) {
  let active: Activation[] = []
  let nouns: Nouns = {}
  let descriptionCache = { value: new WeakMap<Tool, Map<string, Promise<string>>>() }
  let descriptionOrigins = services.pluginOrigin
  let binding: ModBinding | undefined
  let publicTurn: { turnId: string } | undefined
  let stopped = false
  let queue = Promise.resolve()
  let declarations: ModPluginInput[] = []
  let recovering = false
  let hostEpoch = 0
  let hostDead = false
  const activations = new Set<Activation>()
  const retired = new Set<Activation>()
  const interfaceStates = new WeakMap<Nouns, InterfaceState>()
  const capabilityContext = new AsyncLocalStorage<{ table: Nouns; active: boolean; hook?: { plugin: string; registrationId: number } }>()
  const invocationSignal = new AsyncLocalStorage<AbortSignal>()
  const requestServices = new AsyncLocalStorage<ModRequestServices>()
  const uiContext = new AsyncLocalStorage<{ snapshot: readonly Activation[]; table: Nouns; person: boolean; active?: boolean }>()
  const drawingCallbackPlugin = new AsyncLocalStorage<string>()
  const drawings = new Map<number, DrawingLease>()
  const ui = createModUi({
    validateTree: tree => { validateModRenderTree(tree) },
    pluginOf: owner => (owner as Activation).declaration.name,
    dispatch: async (owner, event, input, core, options) => {
      const entered = uiContext.getStore()
      const interaction = ['ui.press', 'ui.input', 'ui.select'].includes(event)
      const pane = interaction ? ui.getSnapshot().find(pane => pane.id === input.requestId) : undefined
      const drawing = pane?.drawing === undefined ? undefined : drawings.get(pane.drawing)
      const snapshot = drawing?.snapshot ?? entered?.snapshot ?? active
      const table = drawing?.table ?? entered?.table ?? nouns
      const origin = event === 'ui.open' || options.origin?.kind === 'plugin'
        ? { plugin: (owner as Activation).declaration.name, tier: (owner as Activation).declaration.tier }
        : undefined
      // Noun effects have {value,deny} envelopes; UI interactions/render have
      // their own result contracts. The pane service owns each event exactly once.
      const wrapped = event === 'ui.open' || event === 'ui.close'
      const result = await dispatch(event, input, async rewritten => {
        const value = interaction
          ? await drawingCallbackPlugin.run(input.plugin as string, () => core(rewritten))
          : await core(rewritten)
        return wrapped ? { value } : value
      }, snapshot, table, {
        origin,
        skipOwner: options.skipOwner as Activation | undefined,
        restoreInput: options.restoreInput,
      })
      if (wrapped) {
        if (typeof (result as { deny?: string }).deny === 'string') throw new Error((result as { deny: string }).deny)
        return (result as { value?: unknown }).value
      }
      return result
    },
    draw: async (owner, input, drawing) => {
      const entered = uiContext.getStore()
      const lease: DrawingLease = { owner: owner as Activation, snapshot: entered?.snapshot ?? active, table: entered?.table ?? nouns, participants: new Set() }
      drawings.set(drawing, lease)
      return dispatch('ui.render', input, async () => ({ type: 'Box', children: [] }), lease.snapshot, lease.table, { drawing })
    },
    invokeDrawing: async (owner, drawing, handle, args) => {
      const lease = drawings.get(drawing)
      const plugin = drawingCallbackPlugin.getStore()
      const participant = [...(lease?.participants ?? [])].find(item => item.declaration.name === plugin)
      if (!lease || lease.owner !== owner || !participant || participant.state !== 'active' ||
        (participant.uiPublished && !active.includes(participant)))
        throw new Error('Mod UI drawing callback is stale or belongs to an unknown plugin')
      return withReference(participant, () => uiContext.run({ snapshot: lease.snapshot, table: lease.table, person: true }, async () => {
        await participant.environment.setUiAccess(uiAllowed(participant, lease.table))
        return participant.environment.invokeDrawing(drawing, handle, args)
      }))
    },
    releaseDrawing: async (owner, drawing) => {
      const lease = drawings.get(drawing)
      if (!lease || lease.owner !== owner) return
      drawings.delete(drawing)
      await Promise.all([...lease.participants].map(item => item.environment.releaseDrawing(drawing)))
    },
  })
  let lastInterface: InterfaceState = { owners: new Map(['clock', ...Object.keys(coreHost)].map(noun => [noun, 'engine'])), withheld: new Map() }
  const crashedWithholders = new Map<string, Set<string>>()
  const controller = new AbortController()
  const diagnostic = (plugin: string, stage: string, error: unknown) => onDiagnostic?.({
    plugin, stage, message: error instanceof Error ? error.message : String(error),
  })
  let host = createModEnvironmentHost({ onDied: workerDied, onError: asynchronousError })
  const commands = createModCommands({
    getBuiltinCommands: () => (services.builtinCommands?.() ?? services.commands?.() ?? []).filter(command =>
      command.type === 'prompt'
        ? command.source === 'builtin' || command.source === 'bundled'
        : !command.isMcp && (command.loadedFrom === undefined || command.loadedFrom === 'bundled'),
    ),
    run: async (name, args, context) => {
      const command = commands.list().find(command => command.name === name)
      if (!command) throw new Error(`Mod command /${name} is no longer active`)
      const snapshot = capture({ toolCatalog: () => createToolCatalogForContext(context) })
      try {
        const result = await runModCommand({
          snapshot, command,
          input: { command: name, args, origin: context.modCommand?.origin ?? { kind: 'unclassified' }, presentation: context.modCommand?.presentation ?? services.presentation?.() ?? { columns: 80, isFullscreen: false } },
          signal: context.abortController.signal,
          core: async () => ({ command, messages: [], shouldQuery: false }),
        })
        return { text: result.resultText }
      } finally { snapshot.release() }
    },
  })

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = queue.then(() => {
      if (stopped) throw new Error('Mods runtime disposed')
      return work()
    })
    queue = pending.then(() => {}, () => {})
    return pending
  }

  function cancelWait(owner: Activation, id: number) {
    const wait = owner.waits.get(id)
    if (!wait) return
    owner.waits.delete(id)
    clearTimeout(wait.timer)
    wait.reject(new Error('Module timer cancelled'))
  }

  function releaseUi(owner: Activation): Promise<void> {
    if (owner.uiRelease) return owner.uiRelease
    ui.releaseCandidate(owner)
    if (owner.uiPublished && owner.uiStatus && !active.some(item => item !== owner && item.declaration.name === owner.declaration.name && item.uiStatus))
      services.uiStatus?.(owner.declaration.name, undefined)
    owner.uiRelease = ui.release(owner)
    return owner.uiRelease
  }

  function disposeActivation(owner: Activation): Promise<void> {
    if (owner.dispose) return owner.dispose
    owner.state = 'disposed'
    commands.release(owner)
    owner.controller.abort()
    for (const id of owner.waits.keys()) cancelWait(owner, id)
    owner.dispose = releaseUi(owner).finally(() => owner.environment.dispose()).finally(() => { retired.delete(owner); activations.delete(owner) })
    return owner.dispose
  }

  function retire(owner: Activation) {
    if (owner.state === 'disposed' || owner.state === 'retiring') return
    owner.state = 'retiring'
    void releaseUi(owner).catch(error => diagnostic(owner.declaration.name, 'ui.close', error))
    commands.release(owner)
    retired.add(owner)
    // A pending sleep may belong to an in-flight hook; stop future timer ticks,
    // but do not turn a normal reload into cancellation of that continuation.
    for (const [id, wait] of owner.waits) if (wait.kind !== 'sleep') cancelWait(owner, id)
    if (owner.references === 0) void disposeActivation(owner).catch(error => diagnostic(owner.declaration.name, 'dispose', error))
  }

  async function withReference<T>(owner: Activation, fn: () => Promise<T>): Promise<T> {
    if (owner.state === 'disposed') throw new Error('Module environment unloaded')
    owner.references++
    try { return await fn() }
    finally {
      owner.references--
      if (owner.state === 'retiring' && owner.references === 0) await disposeActivation(owner)
    }
  }

  function checkCall(owner: Activation, op: string, table: Nouns, lease: CapabilityLease) {
    if (stopped || owner.state === 'disposed') throw new Error('Module environment unloaded')
    if (!owner.declaration.calls.includes(op)) throw new Error(`Module capability ${op} is absent from scan`)
    if (owner.state === 'candidate' && !op.startsWith('clock.')) throw new Error('Module has not been admitted')
    const [noun, method] = op.split('.') as [string, string]
    const provider = capabilityContext.getStore()
    const current = provider?.active ? provider.table : lease.building || lease.entries > 0 ? table : nouns
    const state = interfaceStates.get(current)
    const withholders = new Set([...(state?.withheld.get(noun) ?? []), ...(lease.building ? state?.carried?.get(noun) ?? [] : [])].filter(plugin => plugin !== owner.declaration.name))
    if (withholders.size) throw new Error(`Module capability ${op} was withheld by ${[...withholders].join(', ')}`)
    if (!table[noun]?.[method] || (!lease.building && current[noun]?.[method] !== table[noun]?.[method])) {
      throw new Error(`Module capability ${op} was withdrawn`)
    }
  }

  function hostInput(op: string, args: unknown[]): ModInput {
    switch (op) {
      case 'fs.read': case 'fs.stat': {
        const options = args[1] === undefined ? {} : args[1]
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError(`${op} options must be an object`)
        return op === 'fs.read'
          ? { path: args[0], as: (options as ModInput).as === undefined ? 'text' : (options as ModInput).as }
          : { path: args[0], resolve: (options as ModInput).resolve === undefined ? false : (options as ModInput).resolve }
      }
      case 'fs.exists': return { path: args[0] }
      case 'fs.list': return { path: args[0] ?? '.' }
      case 'fs.write': return { path: args[0], text: args[1] }
      case 'env.get': return { name: args[0] }
      case 'env.set': return { name: args[0], value: args[1] }
      case 'store.get': case 'store.delete': return { key: args[0] }
      case 'store.set': return { key: args[0], value: args[1] }
      case 'process.run': return { argv: args[0], ...(args[1] === undefined ? {} : { init: args[1] }) }
      case 'session.authorize': {
        if (args.length) throw new TypeError('session.authorize takes no arguments')
        return {}
      }
      case 'http.fetch': {
        const init = args[1] === undefined ? {} : args[1]
        if (args.length > 2 || !init || typeof init !== 'object' || Array.isArray(init))
          throw new TypeError('http.fetch takes a URL and optional init object')
        return { url: args[0], init }
      }
      case 'settings.read': case 'fs.ancestors': {
        const input = op === 'settings.read' && args[0] === undefined ? {} : args[0]
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${op} args must be an object`)
        return input as ModInput
      }
      case 'prompt.fill': {
        const input = args[0]
        if (
          args.length !== 1 ||
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          typeof (input as ModInput).text !== 'string' ||
          ((input as ModInput).mode !== undefined &&
            !['replace', 'append', 'insert'].includes(
              (input as ModInput).mode as string,
            ))
        )
          throw new TypeError('prompt.fill takes { text, mode? }')
        return {
          text: (input as ModInput).text,
          mode: (input as ModInput).mode ?? 'replace',
        }
      }
      case 'ui.open': case 'ui.close': case 'ui.scroll': case 'ui.focus': case 'command.register': return args[0] as ModInput
      case 'ui.log': {
        const options = args[1] === undefined ? {} : args[1]
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('ui.log options must be an object')
        return { text: args[0], to: (options as ModInput).to === undefined ? 'transcript' : (options as ModInput).to }
      }
      case 'ui.status': return { text: args[0] }
      case 'ui.invalidate': return { event: args[0] }
      case 'ui.resolve': throw new Error('UI resolve requires an admitted terminal hook')
      case 'tool.list': case 'command.list': case 'store.keys': case 'session.cwd': case 'session.root': case 'session.id': case 'session.repo': case 'session.surface': case 'session.messages': case 'prompt.read': {
        if (args.length) throw new TypeError(`${op} takes no arguments`)
        return {}
      }
      default: throw new Error(`Unsupported host capability ${op}`)
    }
  }

  async function hostCall(owner: Activation, op: string, input: ModInput): Promise<unknown> {
    const { fs, process, store, settings } = owner.operations
    switch (op) {
      case 'settings.read': return settings.read(input)
      case 'env.get': return owner.operations.env.get(input.name as string)
      case 'env.set': return owner.operations.env.set(input.name as string, input.value as string | undefined)
      case 'fs.read': case 'fs.list': case 'fs.stat': case 'fs.exists': case 'fs.write': case 'fs.ancestors': case 'process.run': {
        const combined = createCombinedAbortSignal(invocationSignal.getStore(), {signalB:owner.controller.signal})
        try {
          switch (op) {
            case 'fs.read': return await fs.read(input.path as string, { as: input.as as 'text' | 'bytes' }, combined.signal)
            case 'fs.ancestors': return await fs.ancestors(input as Parameters<typeof fs.ancestors>[0], combined.signal)
            case 'fs.list': return await fs.list(input.path as string, combined.signal)
            case 'fs.stat': return await fs.stat(input.path as string, { resolve: input.resolve as boolean }, combined.signal)
            case 'fs.exists': return await fs.exists(input.path as string, combined.signal)
            case 'fs.write': return await fs.write(input.path as string, input.text as string, combined.signal)
            case 'process.run': return await process.run(input.argv as string[], input.init as Parameters<typeof process.run>[1], combined.signal)
          }
        } finally { combined.cleanup() }
      }
      case 'store.get': return store.get(input.key as string)
      case 'store.set': return store.set(input.key as string, input.value)
      case 'store.delete': return store.delete(input.key as string)
      case 'store.keys': return store.keys()
      case 'session.authorize': return owner.operations.session.authorize()
      case 'http.fetch': {
        const combined = createCombinedAbortSignal(invocationSignal.getStore(), { signalB: owner.controller.signal })
        try {
          return await owner.operations.http.fetch(
            input.url as string,
            input.init as Parameters<typeof owner.operations.http.fetch>[1],
            combined.signal,
          )
        } finally { combined.cleanup() }
      }
      case 'ui.open': {
        if (binding?.surface !== 'terminal' || !binding.isInteractive || !services.uiPresentation)
          throw new Error('Mod UI panes are unavailable without an interactive terminal host')
        if (owner.state !== 'active') throw new Error('Mod UI activation is retired')
        const context = uiContext.getStore()
        const origin: ModUiOrigin = context?.person && context.active !== false ? { kind: 'person' } : { kind: 'plugin', name: owner.declaration.name }
        return ui.open(owner, input as ModUiOpenArgs, origin, services.uiPresentation())
      }
      case 'ui.close': {
        if (owner.state !== 'active') throw new Error('Mod UI activation is retired')
        const result = await ui.close(owner, input.id as string, { kind: 'plugin', name: owner.declaration.name })
        if (result && typeof (result as { deny?: string }).deny === 'string') throw new Error((result as { deny: string }).deny)
        return result
      }
      case 'ui.focus': {
        if (owner.state !== 'active') throw new Error('Mod UI activation is retired')
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            typeof input.requestId !== 'string' || !input.requestId ||
            typeof input.key !== 'string' || !input.key)
          throw new TypeError('ui.focus takes { requestId, key }')
        return ui.focus(owner, {
          requestId: input.requestId,
          element: input.key,
          origin: { kind: 'plugin', name: owner.declaration.name },
        })
      }
      case 'ui.scroll': {
        if (owner.state !== 'active') throw new Error('Mod UI activation is retired')
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new TypeError('ui.scroll takes an object')
        const target = input.to
        const site = input.in
        const block = input.block
        const edge = target === 'start' || target === 'end' ? target : undefined
        const targetRequestId = target && typeof target === 'object' && !Array.isArray(target) &&
          typeof (target as ModInput).requestId === 'string' &&
          (target as ModInput).requestId !== '' && !Object.hasOwn(target, 'key')
          ? (target as ModInput).requestId as string
          : undefined
        const key = target && typeof target === 'object' && !Array.isArray(target) &&
          typeof (target as ModInput).key === 'string' &&
          (target as ModInput).key !== '' && !Object.hasOwn(target, 'requestId')
          ? (target as ModInput).key as string
          : undefined
        if ((!edge && targetRequestId === undefined && key === undefined) ||
            edge && (typeof site !== 'string' || !site) ||
            site !== undefined && (typeof site !== 'string' || !site) ||
            block !== undefined && !['start', 'center', 'end', 'nearest'].includes(block as string))
          throw new TypeError('ui.scroll takes { to, in?, block? }')
        return ui.reveal(owner, {
          ...(typeof site !== 'string' ? {} : { requestId: site }),
          ...(targetRequestId === undefined ? {} : { targetRequestId }),
          ...(key === undefined ? {} : { key }),
          ...(edge === undefined ? {} : { edge }),
          ...(block === undefined ? {} : { block: block as 'start' | 'center' | 'end' | 'nearest' }),
          origin: { kind: 'plugin', name: owner.declaration.name },
        })
      }
      case 'ui.invalidate':
        if (owner.state !== 'active') throw new Error('Mod UI activation is retired')
        if (input.event === 'tool.describe') {
          descriptionCache.value = new WeakMap()
          return undefined
        }
        if (input.event !== 'ui.render') throw new Error(`Unsupported UI invalidation ${String(input.event)}`)
        return ui.invalidate(owner, input.event)
      case 'ui.log': case 'ui.status': {
        if (typeof input.text !== 'string' && !(op === 'ui.status' && input.text === undefined)) throw new Error(`${op} requires text`)
        if (owner.state !== 'active') throw new Error('Mod UI activation is retired')
        if (op === 'ui.log') {
          if (!services.uiLog) throw new Error('UI log is unavailable on this host')
          if (input.to !== 'transcript' && input.to !== 'debug') throw new TypeError('ui.log to must be transcript or debug')
          if (owner.uiPublished) services.uiLog(owner.declaration.name, input.text as string, input.to)
          else (owner.uiLogs ??= []).push({ text: input.text as string, to: input.to })
        } else {
          if (!services.uiStatus) throw new Error('UI status is unavailable on this host')
          owner.uiStatus = { text: input.text as string | undefined }
          if (owner.uiPublished) services.uiStatus(owner.declaration.name, owner.uiStatus.text)
        }
        return undefined
      }
      case 'command.register': return commands.register(owner, input as ModCommandSpec)
      case 'command.list': return commands.projection([...(services.commands?.() ?? [])]).map(command => {
        const owner = commands.ownerOf(command) as Activation | undefined
        const plugin = owner?.declaration.name ?? (command.type === 'prompt' ? command.pluginInfo?.pluginManifest.name : undefined)
        const source = owner || command.loadedFrom === 'plugin'
          ? 'plugin'
          : command.type !== 'prompt'
            ? command.loadedFrom === 'mcp' ? 'mcp' : 'builtin'
            : command.source === 'builtin' || command.source === 'bundled'
              ? 'builtin'
              : command.source === 'plugin' || command.source === 'mcp' ? command.source : 'user'
        return {
          name: getCommandName(command), description: command.description, source,
          ...(plugin === undefined ? {} : { plugin }),
        }
      })
      case 'session.cwd': case 'session.root': case 'session.id':
        if (!binding) throw new Error('Module session is not bound')
        return op === 'session.cwd' ? services.cwd?.() ?? binding.cwd
          : op === 'session.root' ? services.root?.() ?? binding.cwd : binding.sessionId
      case 'session.repo': {
        if (!binding) throw new Error('Module session is not bound')
        const cwd = services.cwd?.() ?? binding.cwd
        const root = findCanonicalGitRootFresh(cwd)
        if (!root) return null
        return { root, remote: await getOriginRemoteUrlFresh(cwd), internal: false, name: null }
      }
      case 'session.surface':
        if (!binding) throw new Error('Module session is not bound')
        return binding.surface
      case 'session.messages':
        if (!services.messages) throw new Error('Session messages are unavailable on this host')
        return services.messages()
      case 'prompt.read': {
        const box = services.prompt?.()?.read() ?? emptyPromptBox()
        validatePromptBox(box)
        return structuredClone(box)
      }
      default: throw new Error(`Unsupported host capability ${op}`)
    }
  }

  function engineFor(owner: Activation, snapshot: readonly Activation[], table: Nouns, lease: CapabilityLease): Record<string, unknown> {
    const clock = createModClockBridge({
      now: async () => {
        checkCall(owner, 'clock.now', table, lease)
        const result = await dispatch('clock.now', {}, async () => ({ value: Date.now() }), snapshot, table, {
          origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
        }) as { value: number; deny?: string }
        if (typeof result.deny === 'string') throw new Error(result.deny)
        return result.value
      },
      wait: async (kind, ms, id) => {
        checkCall(owner, `clock.${kind}`, table, lease)
        if (!Number.isFinite(ms) || ms < 0 || (kind === 'every' && ms < 1)) throw new Error('Invalid clock duration')
        if (owner.state === 'retiring' && kind !== 'sleep') throw new Error('Module timer belongs to a retired activation')
        const result = await withReference(owner, () => dispatch(`clock.${kind}`, { ms }, async input => {
          if (typeof input.ms !== 'number' || !Number.isFinite(input.ms) || input.ms < 0 || (kind === 'every' && input.ms < 1)) throw new Error('Invalid clock duration')
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { owner.waits.delete(id); resolve() }, input.ms as number)
            timer.unref?.()
            owner.waits.set(id, { kind, timer, reject })
          })
          return { value: undefined }
        }, snapshot, table, { origin: { plugin: owner.declaration.name, tier: owner.declaration.tier } })) as { value?: undefined; deny?: string }
        if (typeof result.deny === 'string') throw new Error(result.deny)
      },
      cancel: id => cancelWait(owner, id),
      run: async (callback, kind) => {
        checkCall(owner, `clock.${kind}`, table, lease)
        if (owner.state !== 'active' && !(owner.state === 'candidate' && lease.building)) throw new Error('Module timer belongs to a retired activation')
        // A callback enters the generation captured when its clock was injected.
        for (const item of snapshot) item.references++
        lease.entries++
        try { return await uiContext.run({ snapshot, table, person: false }, () => withReference(owner, callback)) }
        finally {
          lease.entries--
          for (const item of snapshot) {
            item.references--
            if (item.state === 'retiring' && item.references === 0) await disposeActivation(item)
          }
        }
      },
    })
    async function readPromptForCaller(
      caller: Activation,
      captured: readonly Activation[],
      interfaceTable: Nouns,
    ) {
      if (!caller.declaration.calls.includes('prompt.read'))
        return emptyPromptBox()
      checkCall(caller, 'prompt.read', interfaceTable, lease)
      if (!binding || binding.surface !== 'terminal' || !binding.isInteractive)
        return emptyPromptBox()
      const result = (await withReference(caller, () =>
        dispatch(
          'prompt.read',
          {},
          async () => {
            const box = services.prompt?.()?.read() ?? emptyPromptBox()
            validatePromptBox(box)
            return { value: structuredClone(box) }
          },
          captured,
          interfaceTable,
          {
            signal: invocationSignal.getStore(),
            origin: {
              plugin: caller.declaration.name,
              tier: caller.declaration.tier,
            },
          },
        ),
      )) as { value?: unknown; deny?: string }
      if (typeof result.deny === 'string') return emptyPromptBox()
      validatePromptBox(result.value)
      return structuredClone(result.value)
    }

    const result: Record<string, unknown> = table.clock ? { clock } : {}
    for (const [noun, methods] of Object.entries(table)) {
      if (noun === 'clock') continue
      if (noun === 'plugin') {
        result.plugin = Object.freeze({ name: owner.declaration.name, root: owner.declaration.pluginRoot })
        continue
      }
      const wrapped: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
      for (const [method, fn] of Object.entries(methods)) wrapped[method] = async (...args) => {
        const op = `${noun}.${method}`
        checkCall(owner, op, table, lease)
        const input = fn === hostIdentity ? hostInput(op, args) : args[0] ?? {}
        if (op === 'env.get' || op === 'env.set') {
          const name = (input as ModInput).name
          const allowed = owner.declaration.env?.[op === 'env.get' ? 'reads' : 'writes']
          if (typeof name !== 'string' || !allowed?.includes(name))
            throw new Error(`Module environment name ${String(name)} is absent from scan for ${op}`)
        }
        if (fn !== hostIdentity && (args.length > 1 || typeof input !== 'object' || input === null || Array.isArray(input))) {
          throw new Error('Custom noun methods require one object argument or no arguments')
        }
        if (fn === hostIdentity && op === 'prompt.read')
          return readPromptForCaller(owner, snapshot, table)
        if (fn === hostIdentity && ['ui.open', 'ui.close', 'ui.scroll', 'ui.focus'].includes(op))
          return withReference(owner, () => hostCall(owner, op, input as ModInput))
        if (fn === hostIdentity && op === 'prompt.fill') {
          const prompt = services.prompt?.()
          const origin = {
            kind: 'plugin' as const,
            name: owner.declaration.name,
          }
          const eventInput: PromptFillInput = {
            ...(input as ModInput),
            origin,
          } as PromptFillInput
          const result = (await withReference(owner, () =>
            dispatch(
              op,
              eventInput,
              async rewritten =>
                applyPromptFill(
                  prompt,
                  rewritten as PromptFillInput,
                  !binding ||
                    binding.surface !== 'terminal' ||
                    !binding.isInteractive ||
                    prompt?.isBlocked?.() === true,
                ),
              snapshot,
              table,
              {
                signal: invocationSignal.getStore(),
                origin: {
                  plugin: owner.declaration.name,
                  tier: owner.declaration.tier,
                },
                validateInput: value =>
                  validatePromptFillInput(value, origin),
                restoreInput: (value, received) =>
                  Object.hasOwn(value, 'origin')
                    ? value
                    : { ...value, origin: received.origin },
              },
            ),
          )) as { isFilled: boolean }
          return {
            ...result,
            ...(await readPromptForCaller(owner, snapshot, table)),
          }
        }
        const catalog = fn === hostIdentity && op === 'tool.list'
          ? (requestServices.getStore()?.toolCatalog ?? services.toolCatalog)?.()
          : undefined
        if (fn === hostIdentity && op === 'tool.list' && !catalog)
          throw new Error('Tool catalog is unavailable on this host')
        const result = await withReference(owner, () => dispatch(op, input as ModInput, async rewritten => {
          if (catalog) return { value: await catalog.list() }
          const entered = capabilityContext.getStore()
          const provider = { table: entered?.active ? entered.table : lease.entries > 0 || lease.building ? table : nouns, active: true }
          try { return { value: await capabilityContext.run(provider, () => fn === hostIdentity ? hostCall(owner, op, rewritten) : fn(rewritten)) } }
          finally { provider.active = false }
        }, snapshot, table, {
          origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
          ...(catalog ? { validateResult: catalog.validateResult } : {}),
        })) as { value?: unknown; deny?: string }
        if (typeof result.deny === 'string') throw new Error(result.deny)
        return result.value
      }
      if (noun === 'store') {
        for (const method of ['get', 'set', 'delete'] as const) {
          if (methods[method] === hostIdentity && wrapped[method])
            createModStoreBridge(method, wrapped[method])
        }
      }
      result[noun] = noun === 'ui' && !lease.building
        ? createModUiBridge(wrapped)
        : Object.freeze(wrapped)
    }
    return Object.freeze(result)
  }

  function uiAllowed(owner: Activation, table: Nouns): boolean {
    const current = owner.uiPublished ? nouns : table
    return binding?.surface === 'terminal' && owner.state === 'active' && owner.declaration.calls.includes('ui.resolve') &&
      Boolean(table.ui?.resolve && current.ui?.resolve) &&
      ![...(interfaceStates.get(table)?.withheld.get('ui') ?? []), ...(interfaceStates.get(current)?.withheld.get('ui') ?? [])]
        .some(name => name !== owner.declaration.name)
  }

  function hooksFor(snapshot: readonly Activation[], table: Nouns, only?: Activation, drawing?: number, skipOwner?: Activation): ModDispatchHook[] {
    return snapshot.filter(owner => (!only || owner === only) && owner !== skipOwner).flatMap(owner => owner.environment.registrations.map(registration => ({
      plugin: owner.declaration.name,
      tier: owner.declaration.tier,
      registration,
      invoke: (input, next, catching) => withReference(owner, async () => {
        const lease = { entries: 1 }
        const entered = { table, active: true, hook: { plugin: owner.declaration.name, registrationId: registration.id } }
        try {
          if (registration.event !== 'engine.create') await owner.environment.setUiAccess(uiAllowed(owner, table))
          if (drawing !== undefined) drawings.get(drawing)?.participants.add(owner)
          const origin = input.origin as { kind?: string } | undefined
          const parent = uiContext.getStore()
          const person = registration.event === 'command.run'
            ? origin?.kind === 'composer' || origin?.kind === 'shortcut'
            : Boolean(parent?.person && parent.active !== false)
          const uiInvocation = { snapshot, table, person, active: true }
          try {
            return await uiContext.run(uiInvocation, () => invocationSignal.run(next.signal, () => capabilityContext.run(entered, () => owner.environment.invoke(
              catching ? registration.catchId! : registration.id,
              [registration.event === 'engine.create' ? Object.freeze({}) : engineFor(owner, snapshot, table, lease), input], next, drawing,
            ))))
          } finally { uiInvocation.active = false }
        } finally { lease.entries--; entered.active = false }
      }),
    } satisfies ModDispatchHook)))
  }

  function validateResult(event: string, result: unknown) {
    if (event === 'env.get' || event === 'env.set') {
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error(`${event} must return value or deny`)
      if ('deny' in result && typeof result.deny === 'string') return
      if (!('value' in result) || (event === 'env.get'
        ? result.value !== undefined && typeof result.value !== 'string'
        : result.value !== undefined))
        throw new Error(`${event} must return ${event === 'env.get' ? 'a string or undefined' : 'undefined'} in value or deny`)
      return
    }
    if (event === 'prompt.read') {
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new TypeError('prompt.read must return value or deny')
      if ('deny' in result && typeof result.deny === 'string') return
      if (!('value' in result))
        throw new TypeError('prompt.read must return value or deny')
      validatePromptBox(result.value)
      return
    }
    if (event === 'prompt.fill') {
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        typeof (result as Partial<{ isFilled: boolean }>).isFilled !== 'boolean'
      )
        throw new TypeError('prompt.fill must return isFilled')
      return
    }
    if (event.startsWith('clock.')) {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${event} must return value or deny`)
      if ('deny' in result && typeof result.deny === 'string') return
      if (!('value' in result) || (event === 'clock.now'
        ? typeof result.value !== 'number' || !Number.isFinite(result.value)
        : result.value !== undefined)) throw new Error(`${event} must return ${event === 'clock.now' ? 'a finite number' : 'undefined'} in value or deny`)
      return
    }
    if (event === 'prompt.context') {
      if (!result || typeof result !== 'object' || !('blocks' in result) || !Array.isArray(result.blocks))
        throw new Error('prompt.context must return blocks')
      return
    }
    if (event.startsWith('classic.')) {
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error(`${event} must return an object`)
      return
    }
    if (event === 'ui.render') {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('ui.render must return an element')
      return
    }
    if (['ui.press', 'ui.input', 'ui.select', 'ui.focus', 'ui.scroll'].includes(event)) {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${event} must return an object`)
      return
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${event} must return an object`)
    const value = result as Record<string, unknown>
    if (['prompt.section', 'skill.prompt', 'attribution.text'].includes(event)) {
      if (typeof value.text !== 'string' && !(event === 'prompt.section' && value.text === null))
        throw new Error(`${event} must return text`)
      return
    }
    if (event === 'tool.describe' || event === 'command.describe') {
      if (typeof value.description !== 'string' || (event === 'command.describe' && typeof value.isHidden !== 'boolean'))
        throw new Error(`${event} must return description${event === 'command.describe' ? ' and isHidden' : ''}`)
      return
    }
    if (event === 'agent.offer') {
      if (typeof value.isOffered !== 'boolean') throw new Error('agent.offer must return isOffered')
      return
    }
    if (event === 'agent.spawn') {
      if (typeof value.model !== 'string' && typeof value.deny !== 'string') throw new Error('agent.spawn must return model or deny')
      return
    }
    if (event === 'tool.call' && !('result' in value) && typeof value.deny !== 'string') throw new Error('tool.call must return result or deny')
    if (event === 'plugin.register' && value.allow !== true && typeof value.refuse !== 'string') throw new Error('plugin.register must allow or refuse')
    if (event === 'session.start' && typeof value.cwd !== 'string') throw new Error('session.start must return cwd')
    if (event === 'command.run' && value.text !== undefined && typeof value.text !== 'string') throw new Error('command.run text must be a string')
    if (event === 'turn.start' && typeof value.turnId !== 'string') throw new Error('turn.start must return turnId')
    if (event === 'turn.complete' && typeof value.text !== 'string') throw new Error('turn.complete must return text')
    if (event === 'prompt.submit' && typeof value.text !== 'string' && typeof value.drop !== 'string') throw new Error('prompt.submit must return text or drop')
    if (!['tool.call', 'plugin.register', 'session.start', 'engine.create', 'command.run', 'turn.start', 'turn.complete', 'prompt.submit'].includes(event) && !('value' in value) && typeof value.deny !== 'string') {
      throw new Error(`${event} must return value or deny`)
    }
  }

  async function dispatch(
    event: string,
    input: ModInput,
    core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>,
    snapshot: readonly Activation[] = active,
    table: Nouns = nouns,
    options: ModDispatchOptions & { origin?: ModOrigin; only?: Activation; skipOwner?: Activation; drawing?: number; onFailure?: (error: unknown) => void } = {},
  ) {
    if (stopped) throw new Error('Mods runtime disposed')
    const combined = createCombinedAbortSignal(options.signal, { signalB: controller.signal })
    const context = capabilityContext.getStore()
    const caller = context?.active ? context.hook : undefined
    const pinsProvider = ['tool.describe', 'command.describe', 'agent.offer', 'agent.spawn'].includes(event)
    const provider = pinsProvider ? structuredClone(input.provider) : undefined
    for (const owner of snapshot) owner.references++
    try {
      return await dispatchModEvent({
        event, input, hooks: hooksFor(snapshot, table, options.only, options.drawing, options.skipOwner), core,
        signal: combined.signal, origin: options.origin,
        // Only the calling frame is recursive; sibling policy hooks still run.
        ...(options.origin ? { skip: {
          plugin: options.origin.plugin,
          registrationId:
            caller?.plugin === options.origin.plugin
              ? caller.registrationId
              : -1,
        } } : {}),
        validateResult: (result, nextResults) => { validateResult(event, result); options.validateResult?.(result, nextResults) },
        validateInput: (value, received) => {
          if (pinsProvider && !isDeepStrictEqual(value.provider, provider)) throw new Error(`${event} cannot rewrite provider`)
          options.validateInput?.(value, received)
        },
        restoreInput: options.restoreInput,
        onFailure: (plugin, error) => { diagnostic(plugin, event, error); options.onFailure?.(error) },
      })
    } finally {
      combined.cleanup()
      for (const owner of snapshot) {
        owner.references--
        if (owner.state === 'retiring' && owner.references === 0) await disposeActivation(owner)
      }
    }
  }

  async function build(snapshot: Activation[], replacements = new Map<Activation, Activation>()): Promise<{ modules: Activation[]; table: Nouns }> {
    let modules = [...snapshot]
    for (;;) {
      const names = new Set(modules.map(owner => owner.declaration.name))
      const state: InterfaceState = {
        owners: new Map([...lastInterface.owners].filter(([, owner]) => owner === 'engine' || names.has(owner))),
        withheld: new Map(),
        carried: new Map([...lastInterface.withheld].map(([noun, owners]) => [noun, new Set([...owners].filter(owner => names.has(owner)))])),
      }
      for (const [noun, owners] of crashedWithholders) {
        const missing = new Set([...owners].filter(owner => !names.has(owner)))
        if (missing.size) state.withheld.set(noun, missing)
      }
      const base: Nouns = { clock: coreClock, ...coreHost }
      interfaceStates.set(base, state)
      const leases: CapabilityLease[] = []
      let failed: Activation | undefined
      const hooks = modules.flatMap(owner => hooksFor([owner], base).filter(hook => hook.registration.event === 'engine.create').map(hook => ({
        ...hook,
        invoke: async (input: ModInput, next: ModNext, catching: boolean) => {
          let before = base
          let called = false
          const views: { noun: string; view: object; methods: Nouns[string] }[] = []
          const descend = async (input: ModInput, tier?: ModTier) => {
            before = await (tier === undefined ? next(input) : next.to(input, tier)) as Nouns
            called = true
            const lease: CapabilityLease = { entries: 0, building: true }
            leases.push(lease)
            const built = engineFor(owner, modules, before, lease)
            for (const [noun, view] of Object.entries(built)) views.push({ noun, view: view as object, methods: before[noun]! })
            return built
          }
          const continuation = Object.defineProperties((input: ModInput) => descend(input), {
            ...Object.getOwnPropertyDescriptors(next),
            to: { value: (input: ModInput, tier: ModTier) => descend(input, tier) },
          }) as ModNext
          const result = await hook.invoke(input, continuation, catching) as Nouns
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('engine.create must return an interface')
          if (!called) state.endedBy = owner.declaration.name
          const table: Nouns = Object.create(null)
          for (const [noun, methods] of Object.entries(result)) {
            if (!methods || typeof methods !== 'object' || Array.isArray(methods)) throw new Error(`Invalid noun ${noun}`)
            // Ordinary noun objects are cloned across the Worker; their host
            // callable identities survive, while the clock has its own wire tag.
            const inherited = views.find(item => item.noun === noun && (item.view === methods ||
              noun !== 'clock' && Object.keys(methods).length === Object.keys(item.view).length &&
              Object.entries(methods).every(([method, fn]) => fn === (item.view as Nouns[string])[method])))?.methods
            if (inherited) { table[noun] = inherited; continue }
            if (noun === 'plugin') throw new Error('engine.create may not replace plugin identity')
            const entries = Object.entries(methods)
            if (!entries.every(([, fn]) => typeof fn === 'function')) throw new Error(`Noun ${noun} must contain callable methods`)
            const provider = state.owners.get(noun)
            if (provider !== undefined && provider !== owner.declaration.name) {
              const by = [...(state.withheld.get(noun) ?? []), ...(state.carried?.get(noun) ?? [])].at(-1) ?? state.endedBy
              throw new Error(`engine.create may not replace noun ${noun}, owned by ${provider}${by ? ` (withheld by ${by})` : ''}`)
            }
            state.owners.set(noun, owner.declaration.name)
            table[noun] = Object.fromEntries(entries.map(([method, fn]) => {
              let wrapped = owner.methods.get(fn)
              if (!wrapped) {
                wrapped = (...args) => withReference(owner, async () => {
                  if (owner.state === 'candidate') throw new Error('Module has not been admitted')
                  return fn(...args)
                })
                owner.methods.set(fn, wrapped)
              }
              return [method, wrapped]
            }))
          }
          for (const [noun, methods] of Object.entries(before)) {
            if (Object.hasOwn(result, noun)) continue
            const withholders = state.withheld.get(noun) ?? new Set<string>()
            withholders.add(owner.declaration.name)
            state.withheld.set(noun, withholders)
            table[noun] = methods
          }
          interfaceStates.set(table, state)
          return table
        },
      })))
      try {
        const table = await dispatchModEvent({
          event: 'engine.create', input: { plugins: modules.map(item => item.declaration.name) },
          hooks, core: async () => base, signal: controller.signal,
          onFailure: (plugin, error) => {
            if (failed) return
            failed = modules.find(item => item.declaration.name === plugin)
            diagnostic(plugin, 'engine.create', error)
          },
        }) as Nouns
        if (!failed) return { modules, table }
      } catch (error) { if (!failed) throw error }
      finally { for (const lease of leases) lease.building = false }
      const previous = replacements.get(failed!)
      modules = previous
        ? modules.map(owner => owner === failed ? previous : owner)
        : modules.filter(owner => owner !== failed)
      if (!active.includes(failed!)) await disposeActivation(failed!)
    }
  }

  async function admit(candidate: ModDeclaration, judges: readonly Activation[], table: Nouns) {
    const result = await dispatch('plugin.register', {
      name: candidate.name, tier: candidate.tier, root: candidate.pluginRoot, provenance: candidate.storageId,
      ...(candidate.version === undefined ? {} : { version: candidate.version }),
      uses: { events: candidate.events, calls: candidate.calls, ...(candidate.env ? { env: candidate.env } : {}) },
    }, async () => ({ allow: true }), judges, table) as { allow?: true; refuse?: string }
    return result.refuse
  }

  function judgesFor(candidate: ModDeclaration, before: readonly Activation[], after: readonly Activation[]) {
    const eligible = before.filter(judge => judge.state === 'active' && (candidate.tier === 'user' || judge.declaration.tier !== 'user'))
    if (candidate.isNative) return eligible.filter(judge => judge.declaration.isNative)
    return [...eligible, ...after.filter(judge => judge.state === 'active' && (candidate.tier === 'user' ? judge.declaration.tier !== 'user' : judge.declaration.isNative))]
  }

  async function publish(
    built: { modules: Activation[]; table: Nouns },
    replacements = new Map<Activation, Activation>(),
  ) {
    const prepared = new Set<Activation>()
    if (binding) {
      for (;;) {
        let failed: Activation | undefined
        for (const owner of built.modules) {
          if (owner.state !== 'active') continue
          if (owner.started) {
            if (!owner.uiPublished) prepared.add(owner)
            continue
          }
          owner.started = true
          const input = { cwd: binding.cwd, surface: binding.surface, isInteractive: binding.isInteractive }
          try {
            await dispatch('session.start', input, async () => ({ cwd: input.cwd }), built.modules, built.table, {
              only: owner, onFailure: () => { failed = owner },
            })
            if (!failed) {
              commands.validateCommit(owner, replacements.get(owner), [...prepared])
              await uiContext.run({ snapshot: built.modules, table: built.table, person: false }, () => ui.commit(owner, replacements.get(owner)))
              prepared.add(owner)
            }
          } catch (error) {
            if (stopped || hostDead) throw error
            if (!failed) diagnostic(owner.declaration.name, 'session.start', error)
            failed = owner
          }
          if (failed) break
        }
        if (!failed) break
        const old = replacements.get(failed)
        const remaining = old
          ? built.modules.map(owner => owner === failed ? old : owner)
          : built.modules.filter(owner => owner !== failed)
        await disposeActivation(failed)
        built = await build(remaining, replacements)
        for (const owner of prepared) if (!built.modules.includes(owner)) prepared.delete(owner)
      }
    }
    const replaced = active.filter(owner => !built.modules.includes(owner))
    active = built.modules
    if (nouns !== built.table) descriptionCache = { value: new WeakMap() }
    nouns = built.table
    lastInterface = interfaceStates.get(nouns)!
    await Promise.all(active.map(owner => owner.environment.setUiAccess(uiAllowed(owner, nouns))))
    // Publish the matching hook generation before notifying command subscribers.
    for (const owner of prepared) {
      commands.commit(owner, replacements.get(owner))
      owner.uiPublished = true
      if (owner.uiStatus) services.uiStatus?.(owner.declaration.name, owner.uiStatus.text)
      for (const { text, to } of owner.uiLogs ?? []) services.uiLog?.(owner.declaration.name, text, to)
      owner.uiLogs = undefined
    }
    for (const [noun, owners] of crashedWithholders) {
      for (const owner of active) owners.delete(owner.declaration.name)
      if (!owners.size) crashedWithholders.delete(noun)
    }
    for (const owner of replaced) retire(owner)
    const staleDrawings = [...drawings.values()].some(lease => [...lease.participants].some(owner => !active.includes(owner)))
    if (staleDrawings && services.uiPresentation && !stopped) await ui.render(services.uiPresentation())
  }

  async function reconcile(inputs: ModPluginInput[]) {
    if (hostDead) {
      host = createModEnvironmentHost({ onDied: workerDied, onError: asynchronousError })
      hostDead = false
    }
    const declaredNames = new Set(inputs.map(input => input.name))
    let releasedWithholding = false
    for (const [noun, owners] of crashedWithholders) {
      for (const owner of owners) if (!declaredNames.has(owner)) { owners.delete(owner); releasedWithholding = true }
      if (!owners.size) crashedWithholders.delete(noun)
    }
    declarations = inputs
    const previous = active
    const epoch = hostEpoch
    const ensureLive = () => {
      if (stopped) throw new Error('Mods runtime disposed')
      if (hostEpoch !== epoch) throw new Error('Mods Worker generation changed during reload')
    }
    const wanted = new Set(inputs.map(input => input.storageId))
    const removed = previous.filter(owner => !wanted.has(owner.declaration.storageId))
    active = previous.filter(owner => wanted.has(owner.declaration.storageId))
    for (const owner of removed) retire(owner)
    const candidates = [...active]
    const replacements = new Map<Activation, Activation>()
    for (const input of inputs) {
      const old = candidates.find(owner => owner.declaration.storageId === input.storageId)
      try {
        const declaration = getNativeModDeclaration(input) ?? await loadModDeclaration(input)
        ensureLive()
        if (old && old.declaration.fingerprint === declaration.fingerprint &&
          old.declaration.name === declaration.name && old.declaration.version === declaration.version &&
          old.declaration.pluginRoot === declaration.pluginRoot && old.declaration.isNative === declaration.isNative) continue
        const preAdmitted = previous.length > 0
        if (preAdmitted) {
          const order = new Map(inputs.map((item, index) => [item.storageId, index]))
          const seats = [...active.filter(owner => owner !== old), { declaration }].sort((a, b) =>
            tierOrder.indexOf(a.declaration.tier) - tierOrder.indexOf(b.declaration.tier) || order.get(a.declaration.storageId)! - order.get(b.declaration.storageId)!)
          const position = seats.findIndex(owner => owner.declaration === declaration)
          const refusal = await admit(declaration, judgesFor(declaration, seats.slice(0, position) as Activation[], seats.slice(position + 1) as Activation[]), nouns)
          if (refusal !== undefined) {
            if (old) {
              candidates.splice(candidates.indexOf(old), 1)
              active = active.filter(owner => owner !== old)
              retire(old)
            }
            diagnostic(declaration.name, 'admission', refusal)
            continue
          }
        }
        const environment = await host.load(declaration)
        const activationController = new AbortController()
        const candidate: Activation = {
          declaration, environment, state: preAdmitted ? 'active' : 'candidate', references: 0, started: false,
          waits: new Map(), methods: new WeakMap(), controller: activationController,
          operations: createModHostOperations({
            cwd: () => { if (!binding) throw new Error('Module session is not bound'); return services.cwd?.() ?? binding.cwd },
            root: () => { if (!binding) throw new Error('Module session is not bound'); return services.root?.() ?? binding.cwd },
            storageId: declaration.storageId, signal: activationController.signal,
            sessionId: () => binding?.sessionId,
            firstPartyCredential: services.firstPartyCredential,
            httpFetch: services.httpFetch,
          }),
        }
        activations.add(candidate)
        if (stopped || epoch !== hostEpoch) {
          await disposeActivation(candidate)
          ensureLive()
        }
        if (old) candidates.splice(candidates.indexOf(old), 1, candidate)
        else candidates.push(candidate)
        if (old) replacements.set(candidate, old)
      } catch (error) {
        ensureLive()
        diagnostic(input.name, old ? 'reload' : 'load', old ? `The previous version stays loaded: ${error instanceof Error ? error.message : error}` : error)
      }
    }
    const order = new Map(inputs.map((input, index) => [input.storageId, index]))
    candidates.sort((a, b) => tierOrder.indexOf(a.declaration.tier) - tierOrder.indexOf(b.declaration.tier)
      || order.get(a.declaration.storageId)! - order.get(b.declaration.storageId)!)
    if (!releasedWithholding && candidates.length === previous.length && candidates.every((owner, index) => owner === previous[index])) return
    let built = await build(candidates, replacements)
    ensureLive()
    const admitted = new Set<Activation>()
    const rank = (owner: Activation) => owner.declaration.isNative ? 0 : owner.declaration.tier !== 'user' ? 1 : 2
    for (const owner of [...built.modules].sort((a, b) => rank(a) - rank(b))) {
      if (owner.state === 'active') { admitted.add(owner); continue }
      const position = built.modules.indexOf(owner)
      const refusal = await admit(owner.declaration, judgesFor(owner.declaration, built.modules.slice(0, position), built.modules.slice(position + 1)), built.table)
      if (refusal !== undefined) {
        diagnostic(owner.declaration.name, 'admission', refusal)
        await disposeActivation(owner)
      } else {
        owner.state = 'active'
        admitted.add(owner)
      }
    }
    if (admitted.size !== built.modules.length) built = await build(built.modules.filter(owner => admitted.has(owner)))
    ensureLive()
    for (const owner of built.modules) owner.state = 'active'
    await publish(built, replacements)
  }

  function asynchronousError(error: Error, environment: number) {
    const owner = [...activations].find(owner => owner.environment.id === environment)
    diagnostic(owner?.declaration.name ?? 'engine', 'async', error)
  }

  function workerDied(error: Error) {
    diagnostic('engine', 'worker', error)
    hostEpoch++
    hostDead = true
    for (const [noun, owners] of lastInterface.withheld) crashedWithholders.set(noun, new Set(owners))
    for (const owner of activations) {
      owner.state = 'disposed'
      void releaseUi(owner).catch(error => diagnostic(owner.declaration.name, 'ui.close', error))
      commands.release(owner)
      owner.controller.abort()
      for (const id of owner.waits.keys()) cancelWait(owner, id)
    }
    active = []
    nouns = {}
    retired.clear()
    activations.clear()
    if (stopped || recovering) return
    recovering = true
    void enqueue(async () => {
      try { await reconcile(declarations) }
      finally { recovering = false }
    }).catch(error => diagnostic('engine', 'recovery', error))
  }

  function capture(hostServices: ModRequestServices = {}): ModSnapshot {
    if (stopped) throw new Error('Mods runtime disposed')
    const snapshot = active
    const table = nouns
    const pluginOrigin = services.pluginOrigin
    if (descriptionOrigins !== pluginOrigin) {
      descriptionOrigins = pluginOrigin
      descriptionCache = { value: new WeakMap() }
    }
    const descriptions = descriptionCache
    let released = false
    for (const owner of snapshot) owner.references++
    return {
      get toolDescriptions() { return descriptions.value },
      pluginOrigin(storageId) {
        const owner = snapshot.find(value => value.declaration.storageId === storageId)
        return owner ? { plugin: owner.declaration.storageId, tier: owner.declaration.tier } : pluginOrigin?.(storageId)
      },
      dispatch: async (event, input, core, options) => {
        if (released) throw new Error('Mods snapshot released')
        return requestServices.run(hostServices, () => dispatch(event, input, core, snapshot, table, options))
      },
      hasHooks: event => snapshot.some(owner => owner.environment.registrations.some(registration => matchesModEventPattern(registration.event, event))),
      release() {
        if (released) return
        released = true
        for (const owner of snapshot) {
          owner.references--
          if (owner.state === 'retiring' && owner.references === 0) void disposeActivation(owner).catch(error => diagnostic(owner.declaration.name, 'dispose', error))
        }
      },
    }
  }

  let disposal: Promise<void> | undefined
  return {
    capture,
    commands,
    ui,
    get activePublicTurnId(): string | undefined { return publicTurn?.turnId },
    beginPublicTurn(turnId: string): () => void {
      if (stopped) throw new Error('Mods runtime disposed')
      const turn = { turnId }
      publicTurn = turn
      return () => {
        if (publicTurn === turn) publicTurn = undefined
      }
    },
    reconcile: (inputs: ModPluginInput[]) => enqueue(() => reconcile(inputs)),
    bind: (next: ModBinding) => enqueue(async () => { binding = next; if (active.length) await publish({ modules: active, table: nouns }) }),
    dispatch: (event: string, input: ModInput, core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>, options?: ModDispatchOptions) => dispatch(event, input, core, active, nouns, options),
    hasHooks: (event: string) => active.some(owner => owner.environment.registrations.some(registration => matchesModEventPattern(registration.event, event))),
    dispose(): Promise<void> {
      if (disposal) return disposal
      stopped = true
      publicTurn = undefined
      controller.abort()
      disposal = (async () => {
        await Promise.all([...activations].map(disposeActivation))
        active = []
        nouns = {}
        await host.dispose()
        await queue
      })()
      return disposal
    },
  }
}

export type ModsRuntime = ReturnType<typeof createModsRuntime>
