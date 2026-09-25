import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import type { ModModelForkRequest, ModModelForkResult } from './types.js'
import { createModAgents, listModAgents } from './agents.js'
import type { AppState } from '../../state/AppState.js'
import { validateTurnStepInput, validateTurnStepChunk, validateTurnStepResult } from './turnStep.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isDeepStrictEqual } from 'node:util'
import type { Tool } from '../../Tool.js'
import type { ExitReason } from '../../entrypoints/agentSdkTypes.js'
import { createToolCatalogForContext, type ModToolDescription, type ToolCatalog } from './toolCatalog.js'
import { createModToolHost } from './toolHost.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import { createModClockBridge, createModStreamBridge, createModEnvironmentHost, createModStoreBridge, createModUiBridge, createModUiCoreTable, type ModEnvironment } from './environment.js'
import { createModClients, copyModClientData, findModClient } from './client.js'
import { createModUi, type ModRenderComponent, type ModRenderSurface, type ModUiOwner, type ModUiOpenArgs, type ModUiOrigin, type ModUiPresentation } from './ui.js'
import { loadModDeclaration } from './loader.js'
import { getNativeModDeclaration } from './native.js'
import { matchesModEventPattern } from './matcher.js'
import { createModHostOperations, type ModHttpServices } from './hostOperations.js'
import { createModCommands, type ModCommandSpec } from './commands.js'
import { createModTools, type ModToolSpec } from './tools.js'
import { describeModCommand, runModCommand, type CommandPresentation } from './commandAdapter.js'
import { getCommandName, type Command } from '../../types/command.js'
import { validateModRenderTree } from '../../components/ModsPane.js'
import { createModHookStream, dispatchModEvent, dispatchModStream, pauseModBudget } from './dispatch.js'
import { reconcilePromptContext, validatePromptContext, type PromptContext } from './promptContext.js'
import { validateModSessionUsageArgs, validateModSessionUsage, type ModUsageReader } from './sessionUsage.js'
import { createModSessionMeasure } from './sessionMeasure.js'
import { validateModCompactInput, validateModCompactResult } from './compactAdapter.js'
import { validateSessionReceiveResult } from './receiveAdapter.js'
import { logForDebugging } from '../../utils/debug.js'
import { createModConfig, type ModConfigRowProvider, type ModConfigValue } from './config.js'
import { createModModelFork, createModModelClassify, createModModelComplete, type ModModelCompleteRequest } from './modelAdapter.js'
import { getSmallFastModel } from '../../utils/model/model.js'
import { findCanonicalGitRootFresh, getOriginRemoteUrlFresh } from '../../utils/git.js'
import {
  applyPromptFill,
  emptyPromptBox,
  validatePromptBox,
  validatePromptFillInput,
  type ModPromptHost,
  type PromptAttachment,
  type PromptFillInput,
  type PromptSubmitResult,
} from './promptAdapter.js'
import type { ModDeclaration, ModDispatchHook, ModInput, ModNext, ModOrigin, ModTier, ModHookStream } from './types.js'

export type ModPluginInput = {
  name: string
  storageId: string
  version?: string
  /** Set only by a trusted host registration, not by plugin.json or tier. */
  isNative?: boolean
  pluginRoot: string
  entrypoints: string[]
  options?: ModInput
  fingerprintOptions?: ModInput
  tier?: ModTier
}
export type ModBinding = {
  cwd: string
  surface: ModRenderSurface | null
  isInteractive: boolean
  sessionId: string
}
export type ModRequestServices = {
  messages?(): readonly unknown[]
  agentSpawn?(
    input: ModInput,
    snapshot: ModSnapshot,
    signal: AbortSignal,
  ): Promise<{ model: string; agentId?: string } | { deny: string }>
  tools?(): readonly Tool[]
  toolHost?(): {
    tools?(): readonly Tool[]
    spawn?(input: ModInput, snapshot: ModSnapshot, signal: AbortSignal, spawnedBy?: string): Promise<{ model: string; agentId?: string } | { deny: string }>
    call(input: ModInput, snapshot: ModSnapshot, signal: AbortSignal, spawnedBy?: string): Promise<unknown>
    check(input: ModInput, signal: AbortSignal): Promise<{ decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string }>
  }
  toolCatalog?(): ToolCatalog
  captureUsage?(): ModUsageReader
  modelFork?(request: ModModelForkRequest, signal?: AbortSignal): Promise<ModModelForkResult>
  modelComplete?(request: ModModelCompleteRequest, signal?: AbortSignal): Promise<string>
  mcpCall?(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  submitPrompt?(input: {
    text: string
    attachments?: readonly PromptAttachment[]
    origin: { kind: 'plugin'; name: string }
    signal: AbortSignal
  }): Promise<PromptSubmitResult>
}
export type ModHostServices = ModRequestServices & ModHttpServices & {
  tasks?(): AppState['tasks']
  agentNames?(): AppState['agentNameRegistry']
  configRows?(): readonly ModConfigRowProvider[] | Promise<readonly ModConfigRowProvider[]>
  pluginOrigin?(storageId: string): ModOrigin | undefined
  cwd?(): string
  root?(): string
  model?(): string
  turns?(): number
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
  caller?: { plugin: string; registrationId: number }
  validateResult?: (value: unknown, nextResults: readonly unknown[]) => void
  validateInput?: (input: ModInput, received: ModInput) => void
  restoreInput?: (input: ModInput, received: ModInput) => ModInput
  reportDirectCoreFailure?: boolean
}
export type ModPromptContext = { result: Promise<PromptContext>; signal: AbortSignal }
export type ModPromptSection = { result: Promise<{text:string | null}>; signal: AbortSignal }
export type ModSnapshot = {
  readonly toolDescriptions?: WeakMap<Tool, Map<string, Promise<ModToolDescription>>>
  readonly promptSections?: Map<string, ModPromptSection>
  readonly promptAttachments?: Map<string, ModPromptSection>
  readonly promptContexts?: Map<string | undefined, ModPromptContext>
  readonly promptContextBoundaries?: Map<string | undefined, string>
  pluginOrigin?(storageId: string): ModOrigin | undefined
  toolOrigin?(tool: Tool): ModOrigin | undefined
  dispatch(event: string, input: ModInput, core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>, options?: ModDispatchOptions): Promise<unknown>
  stream?(event: 'turn.step', input: ModInput, core: (input: ModInput, signal?: AbortSignal) => AsyncGenerator<unknown, unknown>, options?: ModDispatchOptions): ModHookStream
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
  engine?: Record<string, unknown>
  controller: AbortController
  operations: ReturnType<typeof createModHostOperations>
  uiPublished?: boolean
  uiStatus?: { text: string | undefined }
  uiLogs?: { text: string; to: 'transcript' | 'debug' }[]
  suggestionOwner: string
  uiRelease?: Promise<void>
  dispose?: Promise<void>
}
type DrawingLease = {
  owner: ModUiOwner
  snapshot: readonly Activation[]
  table: Nouns
  participants: Set<Activation>
}
type AttachedClient = {
  surface: ModRenderSurface
  clientId: string
  viewport?: { columns: number; rows: number; isFullscreen?: boolean }
  references: number
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
  session: { cwd: hostIdentity, root: hostIdentity, model: hostIdentity, turns: hostIdentity, id: hostIdentity, repo: hostIdentity, surface: hostIdentity, surfaces: hostIdentity, messages: hostIdentity, usage: hostIdentity, authorize: hostIdentity },
  http: { fetch: hostIdentity },
  agent: { spawn: hostIdentity, register: hostIdentity, list: hostIdentity },
  command: { register: hostIdentity, list: hostIdentity },
  config: { list: hostIdentity, set: hostIdentity },
  model: { complete: hostIdentity, classify: hostIdentity, fork: hostIdentity },
  prompt: { read: hostIdentity, fill: hostIdentity, submit: hostIdentity, suggest: hostIdentity },
  mcp: { call: hostIdentity },
  turn: { step: hostIdentity, abort: hostIdentity },
  tool: { list: hostIdentity, check: hostIdentity, call: hostIdentity, register: hostIdentity },
  ui: { open: hostIdentity, close: hostIdentity, blit: hostIdentity, scroll: hostIdentity, focus: hostIdentity, invalidate: hostIdentity, log: hostIdentity, status: hostIdentity, resolve: hostIdentity },
}

export function createModsRuntime({ onDiagnostic, services = {} }: {
  onDiagnostic?: (event: ModDiagnostic) => void
  services?: ModHostServices
} = {}) {
  let active: Activation[] = []
  let nouns: Nouns = {}
  let descriptionCache = { value: new WeakMap<Tool, Map<string, Promise<ModToolDescription>>>() }
  let sectionCache = new Map<string, ModPromptSection>()
  let attachmentCache = new Map<string, ModPromptSection>()
  let contextCache = new Map<string | undefined, ModPromptContext>()
  let contextBoundaries = new Map<string | undefined, string>()
  let descriptionOrigins = services.pluginOrigin
  let binding: ModBinding | undefined
  let publicTurn: { turnId: string; abort?: () => void } | undefined
  const attachedClients = new Map<string, AttachedClient>()
  const clientTransitions = new Map<string, Promise<void>>()
  let stopped = false
  let queue = Promise.resolve()
  let declarations: ModPluginInput[] = []
  let recovering = false
  let hostEpoch = 0
  let activationId = 0
  let hostDead = false
  const activations = new Set<Activation>()
  const retired = new Set<Activation>()
  const interfaceStates = new WeakMap<Nouns, InterfaceState>()
  const capabilityContext = new AsyncLocalStorage<{ snapshot: readonly Activation[]; table: Nouns; active: boolean; hook?: { plugin: string; registrationId: number }; next?: ModNext }>()
  const invocationSignal = new AsyncLocalStorage<AbortSignal>()
  const turnStepCore = new AsyncLocalStorage<(input: ModInput, signal?: AbortSignal) => AsyncGenerator<unknown, unknown>>()
  const requestServices = new AsyncLocalStorage<ModRequestServices>()
  let forkSnapshot: CacheSafeParams | null = null
  let forkGeneration = 0
  const productionModelFork = createModModelFork(() => forkSnapshot)
  const productionModelComplete = createModModelComplete()
  const uiContext = new AsyncLocalStorage<{ snapshot: readonly Activation[]; table: Nouns; person: boolean; active?: boolean }>()
  const drawingCallbackPlugin = new AsyncLocalStorage<string>()
  let publicationNotifications: Set<() => void> | undefined
  const notify = (listener: () => void) => {
    if (publicationNotifications) publicationNotifications.add(listener)
    else listener()
  }
  const agents = createModAgents(owner => (owner as Activation).declaration, notify)
  const config = createModConfig(() => services.configRows?.() ?? [], (event, input, core, options) => dispatch(event, input, core, active, nouns, options), () => nouns)
  const drawings = new Map<number, DrawingLease>()
  const clientOwners = new Map<number, { participant: Activation; owner: object; requestId: string }>()
  const clients = createModClients({
    validate: tree => { validateModRenderTree(tree) },
    request: async (pane, plugin, request) => {
      if (request.op === 'mount') {
        const lease = pane.drawing === undefined ? undefined : drawings.get(pane.drawing)
        const participant = [...(lease?.participants ?? [])].find(item => item.declaration.name === plugin)
        if (!participant || participant.state !== 'active' || !findModClient(pane.tree, plugin, request.element!, request.module!))
          throw new Error('Client drawing is stale')
        clientOwners.set(request.id, { participant, owner: pane.owner, requestId: pane.id })
      }
      const entry = clientOwners.get(request.id)
      if (!entry) return { stopped: true }
      if (entry.owner !== pane.owner || entry.requestId !== pane.id || entry.participant.declaration.name !== plugin)
        throw new Error('Client instance belongs to another drawing')
      if (request.op === 'dispose') clientOwners.delete(request.id)
      if (entry.participant.state !== 'active') { clientOwners.delete(request.id); return { stopped: true } }
      return withReference(entry.participant, () => entry.participant.environment.client(request))
    },
    message: async (pane, plugin, message) => {
      const current = ui.getSnapshot().find(item => item.owner === pane.owner && item.id === pane.id)
      const lease = current?.drawing === undefined ? undefined : drawings.get(current.drawing)
      const participant = [...(lease?.participants ?? [])].find(item => item.declaration.name === plugin)
      if (!participant || !current?.visible || !findModClient(current.tree, plugin, message.element, message.module)) return {}
      return dispatch('ui.message', {
        surface: 'terminal', component: 'Pane', requestId: current.id, ...message,
      }, async () => ({}), lease!.snapshot, lease!.table, {
        only: participant, origin: { plugin: 'client', tier: participant.declaration.tier },
      }) as Promise<{ props?: unknown }>
    },
  })
  const ui = createModUi({
    notify,
    clients,
    validateTree: (tree, input, refs) => { validateModRenderTree(tree, input?.surface, refs) },
    attach: attachClient,
    detach: detachClient,
    pluginOf: owner => (owner as Activation).declaration.name,
    dispatch: async (owner, event, input, core, options) => {
      const entered = uiContext.getStore()
      const interaction = ['ui.press', 'ui.input', 'ui.select'].includes(event)
      const addressedDrawing = interaction || event === 'ui.blit'
      const pane = addressedDrawing ? ui.getSnapshot().find(pane => pane.id === input.requestId) : undefined
      const drawingId = options.drawing ?? pane?.drawing
      const drawing = drawingId === undefined ? undefined : drawings.get(drawingId)
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
    draw: async (owner, input, drawing, core, validateRenderTree) => {
      const entered = uiContext.getStore()
      const lease: DrawingLease = { owner, snapshot: entered?.snapshot ?? active, table: entered?.table ?? nouns, participants: new Set() }
      drawings.set(drawing, lease)
      return dispatch('ui.render', input, core ?? (async () => ({ type: 'Box', children: [] })), lease.snapshot, lease.table, { drawing, validateRenderTree })
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
  const tools = createModTools({
    notify,
    pluginOf: owner => (owner as Activation).declaration.name,
    getTools: () => (requestServices.getStore()?.toolHost ?? services.toolHost)?.()?.tools?.() ??
      (requestServices.getStore()?.tools ?? services.tools)?.() ?? [],
  })
  const commands = createModCommands({
    notify,
    getBuiltinCommands: () => (services.builtinCommands?.() ?? services.commands?.() ?? []).filter(command =>
      command.type === 'prompt'
        ? command.source === 'builtin' || command.source === 'bundled'
        : !command.isMcp && (command.loadedFrom === undefined || command.loadedFrom === 'bundled'),
    ),
    canReplaceBuiltin: (owner, spec, command) => {
      const declaration = (owner as Activation).declaration
      return declaration.storageId === 'diff@builtin' &&
        declaration.tier === 'builtin' &&
        spec.name === 'diff' &&
        command.name === 'diff'
    },
    describe: async (command, registeredOwner) => {
      const snapshot = capture()
      try {
        const owner = registeredOwner as Activation | undefined
        const plugin = command.type === 'prompt' ? command.pluginInfo?.repository : undefined
        const provider: ModOrigin = owner
          ? { plugin: owner.declaration.storageId, tier: owner.declaration.tier }
          : plugin
            ? snapshot.pluginOrigin?.(plugin) ?? { plugin, tier: 'user' }
            : command.isMcp || command.loadedFrom === 'mcp'
              ? { plugin: `mcp:${command.mcpServerName ?? command.name}`, tier: 'user' }
              : command.type === 'prompt' && !['builtin', 'bundled'].includes(command.source)
                ? { plugin: command.source, tier: command.source === 'policySettings' ? 'prepend' : 'user' }
                : { plugin: 'engine', tier: 'core' }
        return await describeModCommand(snapshot, command, provider)
      } finally { snapshot.release() }
    },
    run: async (name, args, context) => {
      const command = commands.list().find(command => command.name === name)
      if (!command) throw new Error(`Mod command /${name} is no longer active`)
      const snapshot = capture({
        toolCatalog: () => createToolCatalogForContext(context),
        toolHost: () => createModToolHost(context, context.canUseTool ?? hasPermissionsToUseTool),
      })
      try {
        const result = await runModCommand({
          snapshot, command,
          input: { command: name, args, origin: context.modCommand?.origin ?? { kind: 'unclassified' }, presentation: context.modCommand?.presentation ?? services.presentation?.() ?? { columns: 80, isFullscreen: false } },
          signal: context.abortController.signal,
          core: async () => ({ command, messages: [], shouldQuery: false, resultText: `No Mod hook answered /${name}.` }),
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

  function attachedSurfaces(): ModRenderSurface[] {
    const surfaces: ModRenderSurface[] = []
    if (binding?.surface) surfaces.push(binding.surface)
    for (const client of attachedClients.values()) if (!surfaces.includes(client.surface)) surfaces.push(client.surface)
    return surfaces
  }

  function transitionClient(clientId: string, work: () => Promise<void>): Promise<void> {
    const previous = clientTransitions.get(clientId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    clientTransitions.set(clientId, current)
    void current.finally(() => {
      if (clientTransitions.get(clientId) === current) clientTransitions.delete(clientId)
    }).catch(() => {})
    return current
  }

  function attachClient(input: Omit<AttachedClient, 'references'>, signal?: AbortSignal): Promise<void> {
    return transitionClient(input.clientId, async () => {
      signal?.throwIfAborted()
      if (stopped) throw new Error('Mods runtime disposed')
      if (!binding) throw new Error('Mod UI client requires a bound session')
      if (ending) throw new Error('Mod UI client cannot attach while the session is ending')
      const existing = attachedClients.get(input.clientId)
      if (existing) {
        if (existing.surface !== input.surface) throw new Error(`Mod UI client ${input.clientId} is already attached to ${existing.surface}`)
        existing.references++
        return
      }
      const client = {...structuredClone(input),references:1}
      const event = {
        surface: client.surface,
        clientId: client.clientId,
        ...(client.viewport === undefined ? {} : {viewport:client.viewport}),
      }
      let committed = false
      await dispatch('session.attach', event, async received => {
        attachedClients.set(client.clientId, client)
        committed = true
        return {clientId:received.clientId}
      }, active, nouns, {signal})
      if (!committed) attachedClients.set(client.clientId, client)
    })
  }

  function detachClient(input: Pick<AttachedClient, 'surface' | 'clientId'> & {reason:'detach'|'end'}, signal?: AbortSignal): Promise<void> {
    return transitionClient(input.clientId, async () => {
      signal?.throwIfAborted()
      const client = attachedClients.get(input.clientId)
      if (!client) return
      if (input.reason === 'detach' && client.references > 1) {
        client.references--
        return
      }
      if (stopped) {
        attachedClients.delete(client.clientId)
        return
      }
      let committed = false
      await dispatch('session.detach', {surface:client.surface,clientId:client.clientId,reason:input.reason}, async event => {
        attachedClients.delete(client.clientId)
        committed = true
        return {clientId:event.clientId}
      }, active, nouns, {signal})
      if (!committed) attachedClients.delete(client.clientId)
    })
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
    services.prompt?.()?.clearSuggestion?.(owner.suggestionOwner)
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
    tools.release(owner)
    agents.release(owner)
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
    tools.release(owner)
    agents.release(owner)
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
    if (stopped || owner.state === 'disposed' || (owner.state === 'retiring' && lease.entries === 0))
      throw new Error('Module environment unloaded')
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

  function validateMcpToolResult(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !Array.isArray((value as ModInput).content) || typeof (value as ModInput).isError !== 'boolean')
      throw new TypeError('mcp.call must return { content, isError, structuredContent? }')
  }

  function hostInput(op: string, args: unknown[]): ModInput {
    switch (op) {
      case 'agent.spawn': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) ||
            typeof (input as ModInput).prompt !== 'string' || !(input as ModInput).prompt ||
            ((input as ModInput).description !== undefined && typeof (input as ModInput).description !== 'string') ||
            ((input as ModInput).subagentType !== undefined && typeof (input as ModInput).subagentType !== 'string') ||
            ((input as ModInput).model !== undefined && typeof (input as ModInput).model !== 'string') ||
            ((input as ModInput).name !== undefined && typeof (input as ModInput).name !== 'string') ||
            ((input as ModInput).cwd !== undefined && typeof (input as ModInput).cwd !== 'string') ||
            Object.keys(input).some(key => !['prompt', 'description', 'subagentType', 'model', 'name', 'cwd'].includes(key)))
          throw new TypeError('agent.spawn takes a prompt and optional description, subagentType, model, name and cwd')
        return input as ModInput
      }
      case 'agent.register': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input))
          throw new TypeError('agent.register takes an agent specification')
        return input as ModInput
      }
      case 'tool.register': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input))
          throw new TypeError('tool.register takes a tool specification')
        return { ...input, inputSchema: (input as ModInput).inputSchema === undefined ? { type: 'object' } : (input as ModInput).inputSchema }
      }
      case 'tool.call': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) ||
            typeof (input as ModInput).tool !== 'string' || !(input as ModInput).tool)
          throw new TypeError('tool.call takes { tool, ...arguments }')
        return input as ModInput
      }
      case 'turn.abort': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) ||
            typeof (input as ModInput).turnId !== 'string')
          throw new TypeError('turn.abort takes { turnId }')
        return {turnId: (input as ModInput).turnId}
      }
      case 'tool.check': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) ||
            typeof (input as ModInput).tool !== 'string' || !(input as ModInput).tool ||
            !Object.hasOwn(input, 'input') || Object.keys(input).some(key => key !== 'tool' && key !== 'input'))
          throw new TypeError('tool.check takes { tool, input }')
        return input as ModInput
      }
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
      case 'session.usage': {
        const input = args[0] === undefined ? {} : args[0]
        if (args.length > 1) throw new TypeError('session.usage takes one optional object')
        validateModSessionUsageArgs(input)
        return input
      }
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
      case 'mcp.call': {
        const callArgs = args[2] === undefined ? {} : args[2]
        if (args.length > 3 || typeof args[0] !== 'string' || !args[0] || typeof args[1] !== 'string' || !args[1] ||
            !callArgs || typeof callArgs !== 'object' || Array.isArray(callArgs))
          throw new TypeError('mcp.call takes server, tool and optional args')
        return { server: args[0], tool: args[1], args: callArgs }
      }
      case 'settings.read': case 'fs.ancestors': {
        const input = op === 'settings.read' && args[0] === undefined ? {} : args[0]
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${op} args must be an object`)
        return input as ModInput
      }
      case 'config.list':
        if (args.length) throw new TypeError('config.list takes no arguments')
        return {}
      case 'config.set':
        if (args.length !== 1) throw new TypeError('config.set takes { key, value }')
        return args[0] as ModInput
      case 'prompt.fill': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) ||
            typeof (input as ModInput).text !== 'string' ||
            ((input as ModInput).mode !== undefined && !['replace', 'append', 'insert'].includes((input as ModInput).mode as string)))
          throw new TypeError('prompt.fill takes { text, mode? }')
        return { text: (input as ModInput).text, mode: (input as ModInput).mode ?? 'replace' }
      }
      case 'prompt.submit': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) ||
            typeof (input as ModInput).text !== 'string' ||
            Object.keys(input).some(key => key !== 'text' && key !== 'attachments'))
          throw new TypeError('prompt.submit takes { text, attachments? }')
        const text = (input as ModInput).text as string
        if (!text.trim()) throw new TypeError('prompt.submit requires a non-empty prompt')
        if (text.trimStart().startsWith('/'))
          throw new TypeError('prompt.submit cannot run slash commands; use command.run')
        const attachments = (input as ModInput).attachments
        if (attachments !== undefined) {
          if (!Array.isArray(attachments))
            throw new TypeError('prompt.submit attachments must be a list')
          for (const attachment of attachments) {
            if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment) ||
                !['image', 'audio', 'document'].includes((attachment as ModInput).type as string) ||
                ((attachment as ModInput).mediaType !== undefined && typeof (attachment as ModInput).mediaType !== 'string') ||
                ((attachment as ModInput).filename !== undefined && typeof (attachment as ModInput).filename !== 'string') ||
                Object.keys(attachment).some(key => key !== 'type' && key !== 'mediaType' && key !== 'filename'))
              throw new TypeError('prompt.submit attachment is invalid')
          }
        }
        return {
          text,
          ...(attachments === undefined ? {} : { attachments }),
        }
      }
      case 'prompt.suggest': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) ||
            typeof (input as ModInput).text !== 'string' || Object.keys(input).some(key => key !== 'text'))
          throw new TypeError('prompt.suggest takes { text }')
        return { text: (input as ModInput).text }
      }
      case 'ui.blit': {
        const input = args[0]
        if (args.length !== 1 || !input || typeof input !== 'object' || Array.isArray(input) ||
            typeof (input as ModInput).requestId !== 'string' || !(input as ModInput).requestId ||
            typeof (input as ModInput).key !== 'string' || !(input as ModInput).key ||
            Object.keys(input).some(key => !['requestId', 'key', 'cells', 'source', 'columns', 'rows'].includes(key)))
          throw new TypeError('ui.blit takes { requestId, key, cells|source, columns?, rows? }')
        const cells = (input as ModInput).cells
        const source = (input as ModInput).source
        if ((typeof cells !== 'string') === (source === undefined) ||
            ((input as ModInput).columns !== undefined && !Number.isInteger((input as ModInput).columns)) ||
            ((input as ModInput).rows !== undefined && !Number.isInteger((input as ModInput).rows)))
          throw new TypeError('ui.blit takes exactly one cells or source payload and optional integer dimensions')
        return input as ModInput
      }
      case 'ui.open': case 'ui.close': case 'ui.scroll': case 'ui.focus': case 'command.register': case 'model.complete': case 'model.fork': return args[0] as ModInput
      case 'model.classify': return { text: args[0], labels: args[1], ...(args[2] === undefined ? {} : { options: args[2] }) }
      case 'ui.log': {
        const options = args[1] === undefined ? {} : args[1]
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('ui.log options must be an object')
        return { text: args[0], to: (options as ModInput).to === undefined ? 'transcript' : (options as ModInput).to }
      }
      case 'ui.status': return { text: args[0] }
      case 'ui.invalidate': return { event: args[0] }
      case 'ui.resolve': throw new Error('UI resolve requires an admitted terminal hook')
      case 'agent.list': case 'tool.list': case 'command.list': case 'store.keys': case 'session.cwd': case 'session.root': case 'session.model': case 'session.turns': case 'session.id': case 'session.repo': case 'session.surface': case 'session.surfaces': case 'session.messages': case 'prompt.read': {
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
      case 'ui.blit': {
        if (owner.state !== 'active') throw new Error('Mod UI activation is retired')
        return ui.blit(owner, input as Parameters<typeof ui.blit>[1])
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
        if (input.event === 'config.describe') {
          config.invalidate()
          return undefined
        }
        if (input.event === 'command.describe') {
          commands.invalidateDescriptions()
          return undefined
        }
        if (input.event === 'tool.describe') {
          descriptionCache.value = new WeakMap()
          return undefined
        }
        if (input.event === 'prompt.section') {
          sectionCache = new Map()
          return undefined
        }
        if (input.event === 'prompt.attachment') {
          attachmentCache = new Map()
          return undefined
        }
        if (input.event === 'prompt.context') {
          contextCache = new Map()
          contextBoundaries = new Map()
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
      case 'tool.register': {
        if (!binding) throw new Error('tool.register requires a bound session')
        if (owner.state !== 'active') throw new Error('Tool registration belongs to a retired activation')
        return tools.register(owner, input as ModToolSpec)
      }
      case 'agent.list': {
        if (!services.tasks) throw new Error('Agent session state is unavailable on this host')
        return listModAgents(services.tasks(), services.agentNames?.())
      }
      case 'agent.register': {
        if (!binding) throw new Error('agent.register requires a bound session')
        if (owner.state !== 'active') throw new Error('Agent registration belongs to a retired activation')
        return agents.register(owner, input)
      }
      case 'command.register': return commands.register(owner, input as ModCommandSpec)
      case 'command.list': return (await commands.describe([...(services.commands?.() ?? [])])).map(command => {
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
      case 'session.surface': return attachedSurfaces()[0] ?? null
      case 'session.surfaces': return attachedSurfaces()
      case 'session.model':
        if (!services.model) throw new Error('Session model is unavailable on this host')
        return services.model()
      case 'session.turns':
        if (!services.turns) throw new Error('Session turn count is unavailable on this host')
        return services.turns()
      case 'turn.abort': {
        if (typeof input.turnId !== 'string') throw new TypeError('turn.abort takes { turnId }')
        if (!publicTurn || input.turnId !== publicTurn.turnId)
          throw new Error(`Cannot abort turn ${input.turnId}; running turn is ${publicTurn?.turnId ?? 'none'}`)
        if (!publicTurn.abort) throw new Error(`Turn ${publicTurn.turnId} has no running model request`)
        publicTurn.abort()
        return undefined
      }
      case 'session.messages': {
        const messages = requestServices.getStore()?.messages ?? services.messages
        if (!messages) throw new Error('Session messages are unavailable on this host')
        return messages()
      }
      case 'prompt.read': {
        const box = services.prompt?.()?.read() ?? emptyPromptBox()
        validatePromptBox(box)
        return structuredClone(box)
      }
      default: throw new Error(`Unsupported host capability ${op}`)
    }
  }

  function engineFor(owner: Activation, snapshot: readonly Activation[], table: Nouns, lease: CapabilityLease, dynamic = false): Record<string, unknown> {
    const scope = () => {
      if (!dynamic) return { snapshot, table, lease }
      const entered = capabilityContext.getStore()
      if (entered?.active) entered.next?.signal.throwIfAborted()
      const current = entered?.active ? entered : uiContext.getStore()
      return current && current.active !== false
        ? { snapshot: current.snapshot, table: current.table, lease: { entries: 1 } }
        : owner.state === 'active' && !active.includes(owner)
          ? { snapshot, table, lease: { entries: 1 } }
          : { snapshot: active, table: nouns, lease: { entries: 0 } }
    }
    const clock = createModClockBridge({
      now: async () => {
        const {snapshot,table,lease}=scope()
        checkCall(owner, 'clock.now', table, lease)
        const caller = capabilityContext.getStore()
        const resumeBudget = pauseModBudget(caller?.active ? caller.next : undefined)
        try {
          const result = await dispatch('clock.now', {}, async () => ({ value: Date.now() }), snapshot, table, {
            origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
          }) as { value: number; deny?: string }
          if (typeof result.deny === 'string') throw new Error(result.deny)
          return result.value
        } finally { resumeBudget?.() }
      },
      wait: async (kind, ms, id) => {
        const {snapshot,table,lease}=scope()
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
        const {snapshot,table,lease}=scope()
        checkCall(owner, `clock.${kind}`, table, lease)
        if (owner.state !== 'active' && !(owner.state === 'candidate' && lease.building)) throw new Error('Module timer belongs to a retired activation')
        // Pin the callback's entry generation until it drains; no hook is its caller.
        for (const item of snapshot) item.references++
        lease.entries++
        const entered={snapshot,table,active:true}
        try { return await capabilityContext.run(entered, () => uiContext.run({ snapshot, table, person: false }, () => withReference(owner, callback))) }
        finally {
          entered.active=false
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
      if (!caller.declaration.calls.includes('prompt.read')) return emptyPromptBox()
      checkCall(caller, 'prompt.read', interfaceTable, lease)
      if (!binding || binding.surface !== 'terminal' || !binding.isInteractive)
        return emptyPromptBox()
      const result = await withReference(caller, () => dispatch(
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
          origin: { plugin: caller.declaration.name, tier: caller.declaration.tier },
        },
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
      let step: ((input: ModInput) => ModHookStream) | undefined
      if (noun === 'turn' && methods.step === hostIdentity) {
        step = createModStreamBridge((input: ModInput) => {
          const { snapshot, table, lease } = scope()
          checkCall(owner, 'turn.step', table, lease)
          const core = turnStepCore.getStore()
          if (!core) throw new Error('turn.step model request is unavailable outside a model step')
          const caller = capabilityContext.getStore()
          const source = stream('turn.step', input, core, snapshot, table, {
            signal: invocationSignal.getStore(), origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
          })
          const pull = async (method: 'next' | 'return' | 'throw', value?: unknown) => {
            const resume = pauseModBudget(caller?.active ? caller.next : undefined)
            try { return await source[method](value as never) } finally { resume?.() }
          }
          return { next: () => pull('next'), return: (value: unknown) => pull('return', value), throw: (error: unknown) => pull('throw', error), result: source.result, [Symbol.asyncIterator]() { return this } }
        })
      }
      const wrapped: Record<string, (...args: unknown[]) => unknown> = {}
      for (const [method, bound] of Object.entries(methods)) wrapped[method] = async (...args) => {
        const {snapshot,table,lease}=scope()
        const op = `${noun}.${method}`
        checkCall(owner, op, table, lease)
        const fn=dynamic ? table[noun]![method]! : bound
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
        const context = capabilityContext.getStore()
        const caller = context?.active ? context.hook : undefined
        const signal = context?.active ? invocationSignal.getStore() : undefined
        const resumeBudget = pauseModBudget(context?.active ? context.next : undefined)
        try {
          if (fn === hostIdentity && op === 'prompt.read')
            return await readPromptForCaller(owner, snapshot, table)
          if (fn === hostIdentity && (op === 'config.list' || op === 'config.set')) {
            const run = (event: string, eventInput: ModInput, core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>, options?: ModDispatchOptions) =>
              dispatch(event, eventInput, core, snapshot, table, {
                ...(options ?? {}), signal,
                ...(op === 'config.set' ? {
                  origin:{plugin:owner.declaration.name,tier:owner.declaration.tier},
                  ...(caller ? {caller} : {}),
                } : {}),
              })
            if (op === 'config.list')
              return await withReference(owner, () => config.list(run, table))
            return await withReference(owner, () => config.set(
              input as {key:string;value:ModConfigValue},
              {kind:'plugin',name:owner.declaration.name},
              run,
            ))
          }
          if (fn === hostIdentity && ['ui.open', 'ui.close', 'ui.blit', 'ui.scroll', 'ui.focus'].includes(op))
            return await withReference(owner, () => hostCall(owner, op, input as ModInput))
          if (fn === hostIdentity && op === 'prompt.fill') {
            const prompt = services.prompt?.()
            const origin = { kind: 'plugin' as const, name: owner.declaration.name }
            const eventInput: PromptFillInput = { ...(input as ModInput), origin } as PromptFillInput
            const result = await withReference(owner, () => dispatch(
              op,
              eventInput,
              async rewritten => applyPromptFill(
                prompt,
                rewritten as PromptFillInput,
                !binding || binding.surface !== 'terminal' || !binding.isInteractive ||
                  prompt?.isBlocked?.() === true,
              ),
              snapshot,
              table,
              {
                signal,
                origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
                validateInput: value => validatePromptFillInput(value, origin),
                restoreInput: (value, received) => Object.hasOwn(value, 'origin')
                  ? value
                  : { ...value, origin: received.origin },
              },
            )) as { isFilled: boolean }
            return { ...result, ...(await readPromptForCaller(owner, snapshot, table)) }
          }
          if (fn === hostIdentity && op === 'prompt.submit') {
            const submit = requestServices.getStore()?.submitPrompt ?? services.submitPrompt
            if (!submit) throw new Error('Prompt submission host is unavailable on this host')
            if (context?.active && (context.next?.event === 'prompt.submit' || publicTurn))
              throw new Error('prompt.submit cannot wait from a turn-holding hook')
            const origin = { kind: 'plugin' as const, name: owner.declaration.name }
            const combined = createCombinedAbortSignal(invocationSignal.getStore(), { signalB: owner.controller.signal })
            try {
              combined.signal.throwIfAborted()
              return await withReference(owner, () => submit({
                text: (input as ModInput).text as string,
                ...((input as ModInput).attachments === undefined
                  ? {}
                  : { attachments: (input as ModInput).attachments as PromptAttachment[] }),
                origin,
                signal: combined.signal,
              }))
            } finally { combined.cleanup() }
          }
          if (fn === hostIdentity && op === 'prompt.suggest') {
            const prompt = services.prompt?.()
            const origin = { kind: 'plugin' as const, name: owner.declaration.name }
            const eventInput = { ...(input as ModInput), origin }
            return withReference(owner, () => dispatch(
              op,
              eventInput,
              async rewritten => {
                if (owner.state !== 'active' || typeof rewritten.text !== 'string' || rewritten.text.trim() === '' ||
                    binding?.surface !== 'terminal' || !binding.isInteractive ||
                    prompt?.read().text !== '' || prompt.canSuggest?.() === false)
                  return { isShown: false }
                const shown = await prompt.suggest?.(
                  rewritten.text,
                  owner.suggestionOwner,
                ) === true
                return { isShown: shown && owner.state === 'active' }
              },
              snapshot,
              table,
              {
                signal,
                origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
                ...(caller ? { caller } : {}),
                validateInput: rewritten => {
                  if (typeof rewritten.text !== 'string' ||
                      !isDeepStrictEqual(rewritten.origin, origin))
                    throw new TypeError('prompt.suggest requires text and cannot rewrite origin')
                },
              },
            ))
          }
          if (fn === hostIdentity && op === 'agent.spawn') {
            const request = requestServices.getStore()
            const spawn = request?.agentSpawn ?? services.agentSpawn ?? request?.toolHost?.()?.spawn ?? services.toolHost?.()?.spawn
            if (!spawn) throw new Error('Agent spawn host is unavailable on this host')
            const combined = createCombinedAbortSignal(invocationSignal.getStore(), { signalB: owner.controller.signal })
            let open = true
            const callSnapshot: ModSnapshot = {
              dispatch: (event, eventInput, core, options) => {
                if (!open) throw new Error('Mod agent invocation settled')
                return dispatch(event, eventInput, core, snapshot, table, {
                  ...options,
                  origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
                  ...(caller ? { caller } : {}),
                })
              },
              hasHooks: event => snapshot.some(item =>
                item.environment.registrations.some(registration =>
                  matchesModEventPattern(registration.event, event) &&
                  (item !== owner || registration.id !== caller?.registrationId),
                )),
              release() {},
            }
            try {
              combined.signal.throwIfAborted()
              return await withReference(owner, () => spawn(input as ModInput, callSnapshot, combined.signal, owner.declaration.name))
            } finally { open = false; combined.cleanup() }
          }
          if (fn === hostIdentity && op === 'tool.call') {
            const host = (requestServices.getStore()?.toolHost ?? services.toolHost)?.()
            if (!host) throw new Error('Tool execution host is unavailable on this host')
            const combined = createCombinedAbortSignal(invocationSignal.getStore(), { signalB: owner.controller.signal })
            let open = true
            const callSnapshot: ModSnapshot = {
              dispatch: (event, input, core, options) => {
                if (!open) throw new Error('Mod tool invocation settled')
                return dispatch(event, input, core, snapshot, table, {
                  ...options,
                  origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
                  ...(caller ? {caller} : {}),
                })
              },
              hasHooks: event => snapshot.some(item =>
                item.environment.registrations.some(registration =>
                  matchesModEventPattern(registration.event, event) &&
                  (item !== owner || registration.id !== caller?.registrationId),
                )),
              release() {},
            }
            try {
              combined.signal.throwIfAborted()
              return await withReference(owner, () => host.call(input as ModInput, callSnapshot, combined.signal, owner.declaration.name))
            } finally { open = false; combined.cleanup() }
          }
          if (fn === hostIdentity && op === 'tool.check') {
            const host = (requestServices.getStore()?.toolHost ?? services.toolHost)?.()
            if (!host) throw new Error('Tool permission host is unavailable on this host')
            const combined = createCombinedAbortSignal(invocationSignal.getStore(), { signalB: owner.controller.signal })
            try {
              return await withReference(owner, () => dispatch(op, input as ModInput,
                async (question, signal) => host.check(question, signal ?? combined.signal), snapshot, table, {
                  origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
                  signal: combined.signal,
                }))
            } finally { combined.cleanup() }
          }
          if (fn === hostIdentity && op === 'mcp.call') {
            const call = requestServices.getStore()?.mcpCall ?? services.mcpCall
            if (!call) throw new Error('MCP execution host is unavailable on this host')
            const combined = createCombinedAbortSignal(invocationSignal.getStore(), { signalB: owner.controller.signal })
            try {
              const result = await withReference(owner, () => dispatch(op, input as ModInput, async (rewritten, signal) => ({
                value: await call(
                  rewritten.server as string,
                  rewritten.tool as string,
                  rewritten.args as Record<string, unknown>,
                  signal ?? combined.signal,
                ).then(value => {
                  validateMcpToolResult(value)
                  return value
                }),
              }), snapshot, table, {
                origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
                signal: combined.signal,
                ...(caller ? {caller} : {}),
                validateInput: rewritten => {
                  if (typeof rewritten.server !== 'string' || !rewritten.server ||
                      typeof rewritten.tool !== 'string' || !rewritten.tool ||
                      !rewritten.args || typeof rewritten.args !== 'object' || Array.isArray(rewritten.args))
                    throw new TypeError('mcp.call requires server, tool and args')
                },
                validateResult: value => {
                  const returned = value as {value?:unknown;deny?:unknown}
                  if (typeof returned.deny !== 'string') validateMcpToolResult(returned.value)
                },
              })) as {value?:unknown;deny?:string}
              if (typeof result.deny === 'string') throw new Error(result.deny)
              return result.value
            } finally { combined.cleanup() }
          }
          const catalog = fn === hostIdentity && op === 'tool.list'
            ? (requestServices.getStore()?.toolCatalog ?? services.toolCatalog)?.()
            : undefined
          if (fn === hostIdentity && op === 'tool.list' && !catalog)
            throw new Error('Tool catalog is unavailable on this host')
          const usage = fn === hostIdentity && op === 'session.usage'
            ? (requestServices.getStore()?.captureUsage ?? services.captureUsage)?.()
            : undefined
          if (fn === hostIdentity && op === 'session.usage' && !usage)
            throw new Error('Session usage is unavailable on this host')
          const result = await withReference(owner, () => dispatch(op, input as ModInput, async (rewritten, signal) => {
            if (catalog) return { value: await catalog.list() }
            if (usage) {
              validateModSessionUsageArgs(rewritten)
              return { value: await usage(rewritten, signal) }
            }
            const completion = requestServices.getStore()?.modelComplete ?? services.modelComplete ?? productionModelComplete
            if (op === 'model.fork') {
              const fork = requestServices.getStore()?.modelFork ?? services.modelFork ?? productionModelFork
              return { value: fork ? await fork(rewritten as ModModelForkRequest, signal) : null }
            }
            if (op === 'model.complete') {
              return { value: await completion(rewritten as ModModelCompleteRequest, signal) }
            }
            if (op === 'model.classify') {
              const classify = createModModelClassify(async (request, completionSignal) => {
                const completed = await dispatch('model.complete', request, async (received, nestedSignal) => ({
                  value: await completion(received as ModModelCompleteRequest, nestedSignal),
                }), snapshot, table, {
                  origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
                  signal: completionSignal,
                  caller,
                }) as { value?: unknown; deny?: string }
                if (typeof completed.deny === 'string') throw new Error(completed.deny)
                return completed.value as string
              }, getSmallFastModel)
              return { value: await classify(
                rewritten.text as string,
                rewritten.labels as string[],
                rewritten.options as {model?:string} | undefined,
                signal,
              ) }
            }
            const entered = capabilityContext.getStore()
            const provider = { snapshot, table: entered?.active ? entered.table : lease.entries > 0 || lease.building ? table : nouns, active: true }
            try {
              if (fn === hostIdentity)
                return { value: await capabilityContext.run(provider, () => hostCall(owner, op, rewritten)) }
              return { value: await capabilityContext.run(provider, () => fn(rewritten)) }
            } finally { provider.active = false }
          }, snapshot, table, {
            origin: { plugin: owner.declaration.name, tier: owner.declaration.tier },
            ...(fn === hostIdentity && signal ? { signal } : {}),
            reportDirectCoreFailure: fn === hostIdentity && ['store.get', 'store.set', 'store.delete'].includes(op),
            ...(catalog ? { validateResult: catalog.validateResult } : {}),
          })) as { value?: unknown; deny?: string }
          if (typeof result.deny === 'string') throw new Error(result.deny)
          return result.value
        } finally { resumeBudget?.() }
      }
      if (step) wrapped.step = step
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

  const emptyEngine = Object.freeze({})
  function engineFacade(owner: Activation, table: Nouns, snapshot: readonly Activation[] = active): Record<string, unknown> {
    if (!owner.engine) {
      const declared: Nouns = Object.create(null)
      for (const op of owner.declaration.calls) {
        const [noun, method] = op.split('.') as [string, string]
        const bound = table[noun]?.[method] ?? coreHost[noun]?.[method] ?? (noun === 'clock' ? coreClock[method as keyof typeof coreClock] : hostIdentity)
        ;(declared[noun] ??= Object.create(null))[method] = bound
      }
      if (table.plugin) declared.plugin = table.plugin
      owner.engine = engineFor(owner, snapshot, declared, { entries: 0 }, true)
    }
    return owner.engine
  }

  function uiAllowed(owner: Activation, table: Nouns): boolean {
    const current = owner.uiPublished ? nouns : table
    return binding?.surface != null && owner.state === 'active' && owner.declaration.calls.includes('ui.resolve') &&
      Boolean(table.ui?.resolve && current.ui?.resolve) &&
      ![...(interfaceStates.get(table)?.withheld.get('ui') ?? []), ...(interfaceStates.get(current)?.withheld.get('ui') ?? [])]
        .some(name => name !== owner.declaration.name)
  }

  function hooksFor(snapshot: readonly Activation[], table: Nouns, only?: Activation, drawing?: number, skipOwner?: Activation): ModDispatchHook[] {
    return snapshot.filter(owner => (!only || owner === only) && owner !== skipOwner).flatMap(owner => owner.environment.registrations.map(registration => ({
      plugin: owner.declaration.name,
      tier: owner.declaration.tier,
      registration,
      invokeStream: (input, next, catching) => {
        const entered = { snapshot, table, active: true, hook: { plugin: owner.declaration.name, registrationId: registration.id }, next }
        const run = <T>(call: () => T) => invocationSignal.run(next.signal, () => capabilityContext.run(entered, call))
        return (async function* () {
          owner.references++
          let source: ModHookStream | undefined
          try {
            await owner.environment.setUiAccess(uiAllowed(owner, table))
            source = run(() => owner.environment.invokeStream(catching ? registration.catchId! : registration.id, [engineFacade(owner, table, snapshot), input], next))
            let thrown: { error: unknown } | undefined
            for (;;) {
              const item = await run(() => thrown ? source!.throw(thrown.error) : source!.next())
              thrown = undefined
              if (item.done) return item.value
              try { yield item.value } catch (error) { thrown = { error } }
            }
          } finally {
            try { if (source) await run(() => source!.return(undefined)) }
            finally {
              entered.active = false
              owner.references--
              if (owner.state === 'retiring' && owner.references === 0) await disposeActivation(owner)
            }
          }
        })()
      },
      invoke: (input, next, catching) => withReference(owner, async () => {
        const entered = { snapshot, table, active: true, hook: { plugin: owner.declaration.name, registrationId: registration.id }, next }
        try {
          if (next.event !== 'engine.create') await owner.environment.setUiAccess(uiAllowed(owner, table))
          if (drawing !== undefined) drawings.get(drawing)?.participants.add(owner)
          const origin = input.origin as { kind?: string } | undefined
          const parent = uiContext.getStore()
          const person = registration.event === 'command.run'
            ? origin?.kind === 'composer' || origin?.kind === 'shortcut'
            : Boolean(parent?.person && parent.active !== false)
          const uiInvocation = { snapshot, table, person, active: true }
          try {
            const result = await uiContext.run(uiInvocation, () => invocationSignal.run(next.signal, () => capabilityContext.run(entered, () => owner.environment.invoke(
              catching ? registration.catchId! : registration.id,
              [next.event === 'engine.create' ? emptyEngine : engineFacade(owner, table, snapshot), input], next, drawing,
            ))))
            if (next.event === 'session.receive' && next.trace.length === 0 && result && typeof result === 'object' && typeof (result as ModInput).consumed === 'string')
              logForDebugging(`[Mods] ${owner.declaration.name} session.receive consumed: ${String((result as ModInput).consumed).replace(/[\r\n]/g, ' ').replaceAll(String.fromCharCode(27), ' ')}`)
            return result
          } finally { uiInvocation.active = false }
        } finally { entered.active = false }
      }),
    } satisfies ModDispatchHook)))
  }

  function validateResult(event: string, result: unknown, input?: ModInput) {
    if (event === 'prompt.read') {
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new TypeError('prompt.read must return value or deny')
      if ('deny' in result && typeof result.deny === 'string') return
      if (!('value' in result)) throw new TypeError('prompt.read must return value or deny')
      validatePromptBox(result.value)
      return
    }
    if (event === 'prompt.fill') {
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          typeof (result as Partial<{isFilled:boolean}>).isFilled !== 'boolean')
        throw new TypeError('prompt.fill must return isFilled')
      return
    }
    if (event === 'prompt.suggest') {
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          typeof (result as Partial<{isShown:boolean}>).isShown !== 'boolean')
        throw new TypeError('prompt.suggest must return isShown')
      return
    }
    if (event === 'session.receive') return validateSessionReceiveResult(result)
    if (event === 'session.attach' || event === 'session.detach') {
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as ModInput).clientId !== 'string')
        throw new TypeError(`${event} must return clientId`)
      return
    }
    if (event === 'session.compact') {
      validateModCompactResult(result)
      return
    }
    if (event === 'tool.check') {
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          !['allow', 'ask', 'deny'].includes((result as ModInput).decision as string) ||
          ['reason', 'rule'].some(key => (result as ModInput)[key] !== undefined && typeof (result as ModInput)[key] !== 'string'))
        throw new TypeError('tool.check must return { decision, reason?, rule? }')
      return
    }
    if (event === 'config.describe') {
      const value = result as {label?:unknown;description?:unknown;isHidden?:unknown} | null
      if (!value || typeof value.label !== 'string' || typeof value.isHidden !== 'boolean' ||
        (value.description !== undefined && typeof value.description !== 'string')) throw new TypeError('config.describe requires label, description and isHidden')
      return
    }
    if (event === 'session.usage') {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('session.usage must return value or deny')
      if ('deny' in result && typeof result.deny === 'string') return
      if (!('value' in result)) throw new TypeError('session.usage must return value or deny')
      validateModSessionUsage(result.value)
      return
    }
    if (event === 'model.fork') {
      const envelope = result as {value?: ModModelForkResult; deny?: string} | null
      if (typeof envelope?.deny === 'string') return
      if (!envelope || !('value' in envelope)) throw new TypeError('model.fork must return value or deny')
      const value = envelope.value
      if (value === null) return
      if (!value || typeof value.text !== 'string' || !value.usage ||
        Object.keys(value.usage).length !== 4 ||
        !['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].every(key =>
          typeof (value.usage as Record<string, unknown>)[key] === 'number' &&
          Number.isFinite((value.usage as Record<string, unknown>)[key])))
        throw new TypeError('model.fork must return text and four usage fields, or null')
      return
    }
    if (event === 'model.complete' || event === 'model.classify') {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${event} must return value or deny`)
      if ('deny' in result && typeof result.deny === 'string') return
      if (!('value' in result) || (event === 'model.complete'
        ? typeof result.value !== 'string'
        : result.value !== undefined && typeof result.value !== 'string')) {
        throw new Error(`${event} must return ${event === 'model.complete' ? 'a string' : 'a string, undefined'} or deny`)
      }
      return
    }
    if (event === 'env.get' || event === 'env.set') {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${event} must return value or deny`)
      if ('deny' in result && typeof result.deny === 'string') return
      if (!('value' in result) || (event === 'env.get'
        ? result.value !== undefined && typeof result.value !== 'string'
        : result.value !== undefined)) throw new Error(`${event} must return ${event === 'env.get' ? 'a string or undefined' : 'undefined'} in value or deny`)
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
      validatePromptContext(result)
      return
    }
    if (event.startsWith('classic.')) {
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error(`${event} must return an object`)
      return
    }
    if (event === 'ui.message') {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('ui.message must return an object')
      if (Object.hasOwn(result, 'props')) copyModClientData((result as { props?: unknown }).props)
      return
    }
    if (event === 'ui.render') {
      validateModRenderTree(result, input?.surface as ModRenderSurface | undefined)
      return
    }
    if (event === 'ui.resolve') {
      if (!result || typeof result !== 'object' || Array.isArray(result) || !Object.values(result).every(value => typeof value === 'function'))
        throw new Error('ui.resolve must return an element constructor table')
      return
    }
    if (['ui.press', 'ui.input', 'ui.select', 'ui.focus', 'ui.scroll', 'ui.blit'].includes(event)) {
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${event} must return an object`)
      return
    }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${event} must return an object`)
    const value = result as Record<string, unknown>
    if (['prompt.section', 'prompt.attachment', 'skill.prompt', 'attribution.text'].includes(event)) {
      if (typeof value.text !== 'string' && !(['prompt.section', 'prompt.attachment'].includes(event) && value.text === null))
        throw new Error(`${event} must return text`)
      return
    }
    if (event === 'tool.describe' || event === 'command.describe') {
      if (typeof value.description !== 'string' || (event === 'command.describe' && typeof value.isHidden !== 'boolean'))
        throw new Error(`${event} must return description${event === 'command.describe' ? ' and isHidden' : ''}`)
      if (event === 'tool.describe' && value.isDeferred !== undefined && typeof value.isDeferred !== 'boolean')
        throw new Error('tool.describe isDeferred must be boolean')
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
    if (event === 'session.measure') {
      if (!Array.isArray(value.changed) || !value.changed.every(unit => ['context', 'rateLimits', 'cost'].includes(unit)))
        throw new Error('session.measure must return changed units')
      return
    }
    if (event === 'session.start' && typeof value.cwd !== 'string') throw new Error('session.start must return cwd')
    if (event === 'session.end') {
      if (typeof value.sessionId !== 'string') throw new Error('session.end must return sessionId')
      return
    }
    if (event === 'command.run' && value.text !== undefined && typeof value.text !== 'string') throw new Error('command.run text must be a string')
    if (event === 'turn.start' && typeof value.turnId !== 'string') throw new Error('turn.start must return turnId')
    if (event === 'turn.complete' && typeof value.text !== 'string') throw new Error('turn.complete must return text')
    if (event === 'prompt.submit' && typeof value.text !== 'string' && typeof value.drop !== 'string') throw new Error('prompt.submit must return text or drop')
    if (!['tool.call', 'plugin.register', 'session.start', 'engine.create', 'command.run', 'turn.start', 'turn.complete', 'prompt.submit'].includes(event) && !('value' in value) && typeof value.deny !== 'string') {
      throw new Error(`${event} must return value or deny`)
    }
  }

  function stream(event: 'turn.step', input: ModInput,
    core: (input: ModInput, signal?: AbortSignal) => AsyncGenerator<unknown, unknown>,
    snapshot: readonly Activation[] = active, table: Nouns = nouns, options: ModDispatchOptions = {},
  ): ModHookStream {
    if (stopped) throw new Error('Mods runtime disposed')
    const cancellation = new AbortController()
    const combined = createCombinedAbortSignal(options.signal, { signalB: controller.signal })
    const abort = () => cancellation.abort(options.signal?.aborted ? options.signal.reason : controller.signal.reason)
    combined.signal.addEventListener('abort', abort, { once: true })
    if (combined.signal.aborted) abort()
    const caller = capabilityContext.getStore()?.hook
    const services = requestServices.getStore()
    for (const owner of snapshot) owner.references++
    let entered = false
    let released: Promise<void> | undefined
    const release = () => released ??= (async () => {
      for (const owner of snapshot) {
        owner.references--
        if (owner.state === 'retiring' && owner.references === 0) await disposeActivation(owner)
      }
    })()
    const output = createModHookStream((async function* () {
      entered = true
      let source: ModHookStream | undefined
      try {
        source = dispatchModStream({ event, input, core, hooks: hooksFor(snapshot, table), signal: cancellation.signal, origin: options.origin,
          ...(options.origin ? { skip: { plugin: options.origin.plugin, registrationId: caller?.plugin === options.origin.plugin ? caller.registrationId : -1 } } : {}),
          validateInput: (value, received) => { validateTurnStepInput(value); options.validateInput?.(value, received) },
          validateChunk: validateTurnStepChunk,
          validateResult: (result, previous) => { validateTurnStepResult(result, input); options.validateResult?.(result, previous) },
          onFailure: (plugin, error) => diagnostic(plugin, event, error),
        })
        let thrown: { error: unknown } | undefined
        for (;;) {
          const item = await requestServices.run(services ?? {}, () => turnStepCore.run(core, () => thrown ? source!.throw(thrown.error) : source!.next()))
          thrown = undefined
          if (item.done) return item.value
          try { yield item.value } catch (error) { thrown = { error } }
        }
      } finally {
        try { if (source) await source.return(undefined) }
        finally {
          combined.signal.removeEventListener('abort', abort); combined.cleanup()
          await release()
        }
      }
    })(), error => {
      cancellation.abort(error)
      combined.signal.removeEventListener('abort', abort)
      combined.cleanup()
    }, cancellation.signal)
    void output.result.then(undefined, () => {
      if (!entered) return release()
    }).catch(error => diagnostic('engine', event, error))
    return output
  }

  async function dispatch(
    event: string,
    input: ModInput,
    core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>,
    snapshot: readonly Activation[] = active,
    table: Nouns = nouns,
    options: ModDispatchOptions & { origin?: ModOrigin; only?: Activation; skipOwner?: Activation; drawing?: number; validateRenderTree?: (tree: unknown) => void; onFailure?: (error: unknown) => void } = {},
  ) {
    if (stopped) throw new Error('Mods runtime disposed')
    const context = capabilityContext.getStore()
    const combined = createCombinedAbortSignal(options.signal, { signalB: controller.signal })
    const caller = options.caller ?? (context?.active ? context.hook : undefined)
    const pinsProvider = ['tool.describe', 'command.describe', 'agent.offer', 'agent.spawn'].includes(event)
    const provider = pinsProvider ? structuredClone(input.provider) : undefined
    for (const owner of snapshot) owner.references++
    const dispatchServices = event === 'session.compact'
      ? {...requestServices.getStore(), messages: services.messages}
      : requestServices.getStore() ?? {}
    try {
      return await requestServices.run(dispatchServices, () => dispatchModEvent({
        event, input, hooks: hooksFor(snapshot, table, options.only, options.drawing, options.skipOwner), core,
        signal: combined.signal, origin: options.origin,
        reportDirectCoreFailure: options.reportDirectCoreFailure,
        // Only the calling frame is recursive; sibling policy hooks still run.
        ...(options.origin ? { skip: {
          plugin: options.origin.plugin,
          registrationId: caller?.plugin === options.origin.plugin ? caller.registrationId : -1,
        } } : {}),
        validateResult: (result, nextResults) => {
          if (event === 'ui.render' && options.validateRenderTree) options.validateRenderTree(result)
          else validateResult(event, result, input)
          options.validateResult?.(result, nextResults)
        },
        validateInput: (value, received) => {
          if (event === 'tool.check' && !isDeepStrictEqual(value, input)) throw new Error('tool.check cannot rewrite tool, input or tool_use_id')
          if (event === 'model.fork' && (typeof value.prompt !== 'string' || Object.keys(value).some(key => key !== 'prompt')))
            throw new TypeError('model.fork takes only {prompt: string}')
          if (event === 'session.usage') validateModSessionUsageArgs(value)
          if (event === 'session.compact') {
            validateModCompactInput(value)
            if (value.trigger !== input.trigger || value.agentId !== input.agentId)
              throw new Error('session.compact cannot rewrite trigger or agentId')
          }
          if (pinsProvider && !isDeepStrictEqual(value.provider, provider)) throw new Error(`${event} cannot rewrite provider`)
          options.validateInput?.(value, received)
        },
        restoreInput: (value, received) => {
          if (event === 'session.measure') return received
          const restored = options.restoreInput?.(value, received) ?? value
          if (event === 'session.compact' && restored.agentId === undefined && received.agentId !== undefined)
            return { ...restored, agentId: received.agentId }
          if (event !== 'prompt.context') return restored
          validatePromptContext(received)
          return reconcilePromptContext(restored, received)
        },
        ...(event === 'session.attach' || event === 'session.detach' ? { restoreResult: (result: unknown, previous: unknown, called: boolean) => ({
          clientId: ((called ? previous : input) as ModInput).clientId,
        }) } : event === 'session.measure' ? { restoreResult: (_result: unknown, previous: unknown) => ({
          changed: structuredClone((previous as ModInput).changed),
        }) } : event === 'prompt.context' ? { restoreResult: (result: unknown, previous: unknown) => {
          validatePromptContext(previous)
          return reconcilePromptContext(result, previous)
        } } : {}),
        onFailure: (plugin, error) => { diagnostic(plugin, event, error); options.onFailure?.(error) },
      }))
    } finally {
      combined.cleanup()
      for (const owner of snapshot) {
        owner.references--
        if (owner.state === 'retiring' && owner.references === 0) await disposeActivation(owner)
      }
    }
  }

  async function build(
    snapshot: Activation[],
    replacements = new Map<Activation, Activation>(),
    refresh?: { previous: readonly Activation[]; changed: ReadonlySet<Activation>; table?: Nouns },
  ): Promise<{ modules: Activation[]; table: Nouns }> {
    const previousTable = refresh?.table ?? nouns
    const previousInterface = refresh?.table ? interfaceStates.get(refresh.table)! : lastInterface
    let modules = [...snapshot]
    for (;;) {
      const names = new Set(modules.map(owner => owner.declaration.name))
      const replacedNames = new Set(refresh?.previous.filter(previous =>
        !modules.includes(previous) || [...replacements].some(([candidate, old]) => old === previous && modules.includes(candidate)),
      ).map(owner => owner.declaration.name))
      const state: InterfaceState = refresh ? {
        owners: new Map([...previousInterface.owners].filter(([noun, owner]) =>
          owner === 'engine' || names.has(owner) && (!replacedNames.has(owner) || owner !== previousInterface.owners.get(noun)))),
        withheld: new Map([...previousInterface.withheld].flatMap(([noun, owners]) => {
          const retained = new Set([...owners].filter(owner => names.has(owner) && !replacedNames.has(owner)))
          return retained.size ? [[noun, retained] as const] : []
        })),
      } : {
        owners: new Map([...previousInterface.owners].filter(([, owner]) => owner === 'engine' || names.has(owner))),
        withheld: new Map(),
        carried: new Map([...previousInterface.withheld].map(([noun, owners]) => [noun, new Set([...owners].filter(owner => names.has(owner)))])),
      }
      for (const [noun, owners] of crashedWithholders) {
        const missing = new Set([...owners].filter(owner => !names.has(owner)))
        if (missing.size) state.withheld.set(noun, missing)
      }
      const base: Nouns = refresh ? Object.fromEntries(Object.entries(previousTable).filter(([noun]) => {
        const owner = previousInterface.owners.get(noun)
        return owner === undefined || owner === 'engine' || !replacedNames.has(owner)
      })) : { clock: coreClock, ...coreHost }
      interfaceStates.set(base, state)
      const leases: CapabilityLease[] = []
      let failed: Activation | undefined
      const folding = refresh ? modules.filter(owner => refresh.changed.has(owner)) : modules
      const hooks = folding.flatMap(owner => hooksFor([owner], base).filter(hook => matchesModEventPattern(hook.registration.event, 'engine.create')).map(hook => ({
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
            const built = engineFor(owner, snapshot, before, lease)
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
          event: 'engine.create', input: { plugins: folding.map(item => item.declaration.name) },
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

  const uiSurfaces: readonly ModRenderSurface[] = ['terminal', 'desktop', 'mobile', 'vscode']
  const uiComponents: readonly ModRenderComponent[] = ['AskUserQuestion', 'UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'ToolProgress', 'CommandOutput', 'Spinner', 'TurnDuration', 'InfoNotice', 'SessionMode', 'PromptHint', 'AbovePrompt', 'Pane']

  async function composeUiTables(snapshot: readonly Activation[], table: Nouns) {
    const composed = new Map<ModEnvironment, ReadonlyMap<string, object>>()
    const resolverRegistrations = (owner: Activation) => owner.environment.registrations.filter(registration => registration.event === 'ui.resolve')
    for (const owner of snapshot) {
      if (!owner.declaration.calls.includes('ui.resolve')) continue
      const tables = new Map<string, object>()
      for (const surface of uiSurfaces) for (const component of uiComponents) {
        const input = { surface, component }
        let elements: unknown = createModUiCoreTable(surface, component)
        for (const provider of [...snapshot].reverse()) {
          if (provider === owner) continue
          for (const registration of [...resolverRegistrations(provider)].reverse()) {
            const downstream = elements
            const next = Object.assign(async () => downstream, {
              to: async () => downstream,
              is: () => false,
              signal: controller.signal,
              event: 'ui.resolve',
              origin: { plugin: 'engine', tier: 'core' as const },
              trace: [],
              budget: { ms: 0, remainingMs: Infinity },
            })
            elements = await withReference(provider, async () => provider.environment.invoke(registration.id, [engineFacade(provider, table, snapshot), input], next))
            validateResult('ui.resolve', elements, input)
          }
        }
        tables.set(`${surface}:${component}`, Object.freeze(elements as object))
      }
      composed.set(owner.environment, tables)
    }
    return composed
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
    previouslyActive: readonly Activation[] = active,
  ) {
    let uiTables = await composeUiTables(built.modules, built.table)
    let publishUiTables = await host.prepareUiTables(
      uiTables,
      built.modules.filter(owner => !previouslyActive.includes(owner) && uiTables.has(owner.environment)).map(owner => owner.environment),
    )
    const prepared = new Set<Activation>()
    const uiPublications = new Map<Activation, () => Promise<void>>()
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
              only: owner,
            })
            commands.validateCommit(owner, replacements.get(owner), [...prepared])
            tools.validateCommit(owner, replacements.get(owner), [...prepared])
            agents.validateCommit(owner, replacements.get(owner), [...prepared])
            uiPublications.set(owner, await uiContext.run(
              { snapshot: built.modules, table: built.table, person: false },
              () => ui.prepareCommit(owner, replacements.get(owner), [...prepared]),
            ))
            prepared.add(owner)
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
        uiTables = await composeUiTables(built.modules, built.table)
        publishUiTables = await host.prepareUiTables(
          uiTables,
          built.modules.filter(owner => !previouslyActive.includes(owner) && uiTables.has(owner.environment)).map(owner => owner.environment),
        )
        for (const owner of prepared) if (!built.modules.includes(owner)) prepared.delete(owner)
      }
    }
    await Promise.all(built.modules.map(owner => owner.environment.setUiAccess(uiAllowed(owner, built.table))))
    const notifications = new Set<() => void>()
    const uiCleanup: Promise<void>[] = []
    publicationNotifications = notifications
    try {
      const replaced = active.filter(owner => !built.modules.includes(owner))
      await publishUiTables()
      active = built.modules
      const commandsChanged = nouns !== built.table
      if (nouns !== built.table) {
        descriptionCache = { value: new WeakMap() }
        sectionCache = new Map()
        attachmentCache = new Map()
        contextCache = new Map()
        contextBoundaries = new Map()
      }
      nouns = built.table
      lastInterface = interfaceStates.get(nouns)!
      config.invalidate()
      // Publish the matching hook generation before notifying command subscribers.
      const previousCommands = commands.getSnapshot()
      if (commandsChanged) commands.invalidateDescriptions(false)
      for (const owner of prepared) {
        commands.commit(owner, replacements.get(owner))
        tools.commit(owner, replacements.get(owner))
        agents.commit(owner, replacements.get(owner))
        const publishUi = uiPublications.get(owner)
        if (publishUi) uiCleanup.push(publishUi())
        owner.uiPublished = true
      }
      for (const owner of prepared) {
        if (owner.uiStatus) notify(() => services.uiStatus?.(owner.declaration.name, owner.uiStatus!.text))
        for (const { text, to } of owner.uiLogs ?? []) notify(() => services.uiLog?.(owner.declaration.name, text, to))
        owner.uiLogs = undefined
      }
      for (const [noun, owners] of crashedWithholders) {
        for (const owner of active) owners.delete(owner.declaration.name)
        if (!owners.size) crashedWithholders.delete(noun)
      }
      for (const owner of replaced) retire(owner)
      if (commandsChanged && commands.getSnapshot() === previousCommands) commands.invalidateDescriptions()
    } finally { publicationNotifications = undefined }
    for (const listener of notifications) listener()
    await Promise.all(uiCleanup)
    const staleDrawings = [...drawings.values()].some(lease =>
      lease.snapshot.length !== active.length ||
      lease.snapshot.some((owner, index) => owner !== active[index]))
    if (staleDrawings && !stopped) await ui.render(services.uiPresentation?.())
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
    let candidates = [...active]
    const replacements = new Map<Activation, Activation>()
    const order = new Map(inputs.map((input, index) => [input.storageId, index]))
    const seatOrder = (a: { declaration: ModDeclaration }, b: { declaration: ModDeclaration }) =>
      tierOrder.indexOf(a.declaration.tier) - tierOrder.indexOf(b.declaration.tier) || order.get(a.declaration.storageId)! - order.get(b.declaration.storageId)!
    const cold = previous.length === 0
    const scanned = new Map<ModPluginInput, ModDeclaration>()
    let loading = inputs
    let bootstrap: { modules: Activation[]; table: Nouns } | undefined
    if (cold) {
      for (const input of inputs) {
        try {
          scanned.set(input, getNativeModDeclaration(input) ?? await loadModDeclaration(input))
        } catch (error) {
          ensureLive()
          diagnostic(input.name, 'load', error)
        }
      }
      const rank = (declaration: ModDeclaration) => declaration.isNative ? 0 : declaration.tier !== 'user' ? 1 : 2
      loading = [...scanned.keys()].sort((a, b) => rank(scanned.get(a)!) - rank(scanned.get(b)!) || seatOrder({ declaration: scanned.get(a)! }, { declaration: scanned.get(b)! }))
    }
    async function buildBootstrap() {
      const changed = new Set(candidates.filter(owner => !bootstrap?.modules.includes(owner)))
      if (bootstrap && !changed.size) return
      // Keep newly admitted providers barred during their own bootstrap fold.
      for (const owner of changed) owner.state = 'candidate'
      bootstrap = await build([...candidates].sort(seatOrder), replacements, bootstrap && {
        previous: bootstrap.modules, changed, table: bootstrap.table,
      })
      ensureLive()
      candidates = [...bootstrap.modules]
      for (const owner of candidates) owner.state = 'active'
    }
    for (const input of loading) {
      const old = candidates.find(owner => owner.declaration.storageId === input.storageId)
      try {
        const declaration = scanned.get(input) ?? getNativeModDeclaration(input) ?? await loadModDeclaration(input)
        ensureLive()
        if (old && old.declaration.fingerprint === declaration.fingerprint &&
          isDeepStrictEqual(old.declaration.options, declaration.options) &&
          old.declaration.name === declaration.name && old.declaration.version === declaration.version &&
          old.declaration.pluginRoot === declaration.pluginRoot && old.declaration.isNative === declaration.isNative) continue
        {
          const seats = [...(cold ? candidates : active).filter(owner => owner !== old), { declaration }].sort(seatOrder)
          const position = seats.findIndex(owner => owner.declaration === declaration)
          let judges = judgesFor(declaration, seats.slice(0, position) as Activation[], seats.slice(position + 1) as Activation[])
          if (cold && judges.some(owner => owner.environment.registrations.some(registration => matchesModEventPattern(registration.event, 'plugin.register')))) {
            await buildBootstrap()
            judges = judges.filter(owner => candidates.includes(owner))
          }
          const refusal = await admit(declaration, judges, bootstrap?.table ?? nouns)
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
          declaration, environment, state: 'active', references: 0, started: false,
          waits: new Map(), methods: new WeakMap(), controller: activationController,
          suggestionOwner: `${declaration.storageId}:${++activationId}`,
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
    candidates.sort(seatOrder)
    if (!releasedWithholding && candidates.length === previous.length && candidates.every((owner, index) => owner === previous[index])) return
    const changed = new Set(candidates.filter(owner => !previous.includes(owner)))
    const refresh = previous.length ? { previous, changed } : undefined
    if (cold) await buildBootstrap()
    const built = cold ? bootstrap! : await build(candidates, replacements, refresh)
    ensureLive()
    for (const owner of built.modules) owner.state = 'active'
    await publish(built, replacements, previous)
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
      tools.release(owner)
      agents.release(owner)
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
    const toolOrigins = new Map(tools.list().map(tool => {
      const owner = tools.ownerOf(tool) as Activation
      return [tool, { plugin: owner.declaration.name, tier: owner.declaration.tier }] as const
    }))
    const descriptions = descriptionCache
    const sections = sectionCache
    const attachments = attachmentCache
    const contexts = contextCache
    const boundaries = contextBoundaries
    let released = false
    for (const owner of snapshot) owner.references++
    return {
      toolOrigin: tool => toolOrigins.get(tool),
      get toolDescriptions() { return descriptions.value },
      get promptSections() { return sections },
      get promptAttachments() { return attachments },
      get promptContexts() { return contexts },
      get promptContextBoundaries() { return boundaries },
      pluginOrigin(storageId) {
        const owner = snapshot.find(value => value.declaration.storageId === storageId)
        return owner ? { plugin: owner.declaration.storageId, tier: owner.declaration.tier } : pluginOrigin?.(storageId)
      },
      dispatch: async (event, input, core, options) => {
        if (released) throw new Error('Mods snapshot released')
        return requestServices.run(hostServices, () => dispatch(event, input, core, snapshot, table, options))
      },
      stream: (event, input, core, options) => {
        if (released) throw new Error('Mods snapshot released')
        return requestServices.run(hostServices, () => stream(event, input, core, snapshot, table, options))
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

  function invalidatePromptContext(agentId?: string): void {
    contextCache = new Map(contextCache)
    contextCache.delete(agentId)
    contextBoundaries = new Map(contextBoundaries)
    contextBoundaries.delete(agentId)
  }

  const measurements = createModSessionMeasure({
    ready: () => queue,
    captureUsage: () => services.captureUsage?.(),
    dispatch: (input, reader, signal) => requestServices.run({captureUsage: () => reader}, () =>
      dispatch('session.measure', input, async () => ({changed: input.changed}), active, nouns, {signal})),
    onError: error => diagnostic('engine', 'session.measure', error),
  })
  function measure(captureUsage?: () => ModUsageReader): Promise<void> {
    if (stopped || ending || !binding || !active.some(owner => owner.started &&
      owner.environment.registrations.some(registration => matchesModEventPattern(registration.event, 'session.measure')))) return Promise.resolve()
    return measurements.request(captureUsage)
  }

  let disposal: Promise<void> | undefined
  let ending: Promise<void> | undefined
  function endSession(reason: ExitReason, timeoutMs = 1500, sessionId?: string): Promise<void> {
    if (stopped || !binding || (sessionId !== undefined && binding.sessionId !== sessionId)) return Promise.resolve()
    if (ending) return ending
    forkSnapshot = null
    forkGeneration++
    const input = { reason, sessionId: binding.sessionId, resume: { id: binding.sessionId } }
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new Error('Mods session.end timed out')), timeoutMs)
    ending = measurements.stop().then(async () => {
      for (const client of [...attachedClients.values()]) {
        deadline.signal.throwIfAborted()
        await detachClient({...client,reason:'end'}, deadline.signal)
      }
      await dispatch('session.end', input, async () => ({ sessionId: input.sessionId }), active, nouns, { signal: deadline.signal })
    }).then(() => {}, error => diagnostic('engine', 'session.end', error))
      .finally(() => {
        attachedClients.clear()
        clientTransitions.clear()
        clearTimeout(timer)
      })
    return ending
  }
  return {
    captureForkSnapshotWriter() {
      const generation = forkGeneration
      return (params: CacheSafeParams) => {
        if (!stopped && generation === forkGeneration) forkSnapshot = {
          ...params, forkContextMessages:[...params.forkContextMessages],
          toolUseContext:{...params.toolUseContext, options:{...params.toolUseContext.options}},
        }
      }
    },
    capture,
    invalidatePromptContext,
    measure,
    endSession,
    tools,
    agents,
    commands,
    config,
    ui,
    get activePublicTurnId(): string | undefined { return publicTurn?.turnId },
    beginPublicTurn(turnId: string, abort?: () => void): () => void {
      if (stopped) throw new Error('Mods runtime disposed')
      const turn = { turnId, abort }
      publicTurn = turn
      return () => {
        if (publicTurn === turn) publicTurn = undefined
      }
    },
    reconcile: (inputs: ModPluginInput[]) => enqueue(() => reconcile(inputs)),
    bind: (next: ModBinding) => enqueue(async () => {
      if (!ending && binding && Object.keys(next).every(key =>
        next[key as keyof ModBinding] === binding![key as keyof ModBinding],
      )) return
      if (ending || binding?.sessionId !== next.sessionId) {
        forkSnapshot = null
        forkGeneration++
        await ending
        if (binding && binding.sessionId !== next.sessionId) {
          for (const owner of active)
            services.prompt?.()?.clearSuggestion?.(owner.suggestionOwner)
        }
        await measurements.reset()
        ending = undefined
        commands.invalidateDescriptions()
        sectionCache = new Map()
        attachmentCache = new Map()
        invalidatePromptContext()
      }
      binding = next
      if (active.length) await publish({ modules: active, table: nouns })
    }),
    stream: (event: 'turn.step', input: ModInput, core: (input: ModInput, signal?: AbortSignal) => AsyncGenerator<unknown, unknown>, options?: ModDispatchOptions) => stream(event, input, core, active, nouns, options),
    dispatch: (event: string, input: ModInput, core: (input: ModInput, signal?: AbortSignal) => Promise<unknown>, options?: ModDispatchOptions) => dispatch(event, input, core, active, nouns, options),
    hasHooks: (event: string) => active.some(owner => owner.environment.registrations.some(registration => matchesModEventPattern(registration.event, event))),
    dispose(): Promise<void> {
      if (disposal) return disposal
      stopped = true
      publicTurn = undefined
      forkSnapshot = null
      forkGeneration++
      controller.abort()
      disposal = (async () => {
        await measurements.stop()
        await ui.dispose()
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
