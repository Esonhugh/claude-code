import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isRegExp } from 'node:util/types'
import { pathToFileURL } from 'node:url'
import { SourceTextModule, SyntheticModule, createContext, type Module } from 'node:vm'
import { createPluginFromPath } from '../../../utils/plugins/pluginLoader.js'
import { validateUserConfig, type UserConfigValues } from '../../../utils/plugins/mcpbHandler.js'
import { errorMessage } from '../../../utils/errors.js'
import { createModsRuntime, type ModDiagnostic, type ModPluginInput } from '../runtime.js'
import type { ModInput, ModNext, ModTier, ModRegistration } from '../types.js'
import type { ModRenderComponent, ModRenderInput, ModRenderSite, ModRenderSurface, ModUiCallback } from '../ui.js'
import { expect } from './expect.js'
import { createMock } from './mock.js'
import { modStateLibrarySource } from '../stateLibrary.js'
import { createModHookStream } from '../protocol.js'
import { HOOK_EVENTS } from '../../../entrypoints/sdk/coreTypes.js'

export type PluginTestCaseResult = {
  name: string
  durationMs: number
  failure?: string
}
export type PluginTestFileResult = {
  file: string
  tests: PluginTestCaseResult[]
  loadFailure?: string
}
export type PluginTestResult = {
  files: PluginTestFileResult[]
  passed: number
  failed: number
  durationMs: number
}

type TestBody = ($: Record<string, unknown>, on: TestOn) => unknown
type InlinePlugin = { name: string; tier?: Exclude<ModTier, 'core'>; register: (...args: unknown[]) => unknown }
type TestOptions = { plugins?: readonly InlinePlugin[]; options?: UserConfigValues; timeoutMs?: number }
type TestCase = { name: string; body: TestBody; timeout: number; options: TestOptions }
type TestHook = {
  event: string
  matcher: NonNullable<ModRegistration['matcher']>
  handler: (engine: Record<string, unknown>, input: ModInput, next: TestNext) => unknown
}
type TestNext = ModNext
type TestOn = (
  event: string,
  matcherOrHandler: TestHook['matcher'] | TestHook['handler'],
  handler?: TestHook['handler'],
) => void

type TimerHandle = ReturnType<typeof setTimeout>
type TestRegistry = {
  tests: TestCase[]
  suite: string[]
  tier: ModTier
  timers: Set<TimerHandle>
}

type ElementQuery = { type?: string; key?: string; text?: string | RegExp; in?: string }
type FoundElement = {
  type: string
  key: string | undefined
  props: Record<string, unknown>
  text: string
  children: unknown[]
}

type MountedUi = {
  readonly surface: ModRenderSurface
  key(...args: Parameters<ModRenderSite['key']>): Promise<void>
  pointer(...args: Parameters<ModRenderSite['pointer']>): Promise<void>
  resize(...args: Parameters<ModRenderSite['resize']>): Promise<void>
  post(...args: Parameters<ModRenderSite['post']>): Promise<void>
  advance(...args: Parameters<ModRenderSite['advance']>): Promise<void>
  press(target: { key: string; plugin?: string; link?: { href: string } }): Promise<unknown>
  input(target: { key: string; text: string; kind?: 'change' | 'submit'; plugin?: string }): Promise<unknown>
  select(target: { key: string; value: string; plugin?: string }): Promise<unknown>
  drawn(scope?: { in?: string }): Promise<unknown>
  find(query: ElementQuery): Promise<FoundElement | undefined>
  findAll(query: ElementQuery): Promise<FoundElement[]>
  redraw(props?: ModInput): Promise<void>
  unmount(): Promise<void>
}

const RESULT_MARKER = '__CLAUDE_PLUGIN_TEST_RESULT__'
const tiers: readonly ModTier[] = ['prepend', 'user', 'append', 'builtin', 'core']

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function failure(error: unknown): string {
  return error instanceof Error && error.stack ? error.stack : errorMessage(error)
}

async function filesUnder(root: string): Promise<string[]> {
  const output: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.claude-test-environment') await visit(path)
      }
      else if (entry.isFile() && /(?:^|\.)test\.(?:[cm]?[jt]sx?)$/.test(entry.name)) output.push(path)
    }
  }
  await visit(root)
  return output
}

async function pluginInput(pluginRoot: string, tier: ModTier, values: UserConfigValues = {}): Promise<ModPluginInput> {
  const { plugin, errors } = await createPluginFromPath(
    pluginRoot,
    `${pluginRoot}@test`,
    true,
    pluginRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? 'plugin',
  )
  if (errors.length) throw new Error(errors.map(error => JSON.stringify(error)).join('\n'))
  const entrypoints = [...new Set((plugin.hookModules ?? []).flatMap(group =>
    group.paths.map(path => resolve(dirname(group.configPath), path)),
  ))]
  if (!entrypoints.length) throw new Error(`Plugin has no Mods hook modules: ${pluginRoot}`)
  const schema = plugin.manifest.userConfig ?? {}
  const options = Object.fromEntries(Object.entries(schema).flatMap(([key, field]) => {
    const value = values[key] ?? field.default
    return value === undefined ? [] : [[key, value]]
  }))
  const validation = validateUserConfig(options, schema)
  if (!validation.valid) throw new Error(validation.errors.join('\n'))
  return {
    options,
    name: plugin.name,
    storageId: `${plugin.name}@test`,
    version: plugin.manifest.version,
    pluginRoot,
    entrypoints,
    tier,
  }
}

function createRegistry(): TestRegistry {
  return { tests: [], suite: [], tier: 'user', timers: new Set() }
}

async function loadTestFile(file: string, root: string, registry: TestRegistry): Promise<void> {
  const context = createContext({
    AbortController,
    AbortSignal,
    ArrayBuffer,
    BigInt,
    Blob,
    Boolean,
    Buffer,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    Symbol,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Uint8Array,
    console,
    crypto,
    performance,
    queueMicrotask,
    structuredClone,
    clearInterval: (handle: TimerHandle) => { registry.timers.delete(handle); clearInterval(handle) },
    clearTimeout: (handle: TimerHandle) => { registry.timers.delete(handle); clearTimeout(handle) },
    setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = setInterval(callback, delay, ...args)
      registry.timers.add(handle)
      return handle
    },
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const handle = setTimeout(() => { registry.timers.delete(handle); callback(...args) }, delay)
      registry.timers.add(handle)
      return handle
    },
  })
  const cache = new Map<string, Module>()
  const testing = new SyntheticModule(
    ['describe', 'test', 'expect', 'mock', 'tier'],
    function () {
      const describe = (name: string, body: () => void) => {
        registry.suite.push(name)
        try { body() } finally { registry.suite.pop() }
      }
      const test = (name: string, ...rest: [TestBody] | [Record<string, unknown>, TestBody]) => {
        const options = rest.length === 2 ? rest[0] : {}
        const body = rest.length === 2 ? rest[1] : rest[0]
        if (typeof name !== 'string' || typeof body !== 'function' || !isRecord(options))
          throw new TypeError('test requires (name, body) or (name, options, body)')
        for (const key of Object.keys(options)) {
          if (!['timeoutMs', 'plugins', 'options'].includes(key)) throw new Error(`test option ${key} is not supported`)
        }
        if (options.options !== undefined && !isRecord(options.options)) throw new TypeError('test options must be an object')
        if (options.plugins !== undefined && (!Array.isArray(options.plugins) || options.plugins.some(plugin =>
          !isRecord(plugin) || typeof plugin.name !== 'string' || !plugin.name || typeof plugin.register !== 'function' ||
          (plugin.tier !== undefined && (plugin.tier === 'core' || !tiers.includes(plugin.tier as ModTier))))))
          throw new TypeError('test plugins require name, register and a non-core tier')
        const timeout = options.timeoutMs ?? 5_000
        if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
          throw new TypeError('timeoutMs must be a positive finite number')
        registry.tests.push({
          name: [...registry.suite, name].join(' > '),
          body,
          timeout,
          options: options as TestOptions,
        })
      }
      const tier = (value: ModTier) => {
        if (value === 'core' || !tiers.includes(value)) throw new TypeError(`Unknown plugin test tier: ${String(value)}`)
        registry.tier = value
      }
      this.setExport('describe', describe)
      this.setExport('test', test)
      this.setExport('expect', expect)
      this.setExport('tier', tier)
      this.setExport('mock', createMock())
    },
    { context, identifier: 'claude-code/testing' },
  )
  cache.set('claude-code/testing', testing)
  const state = new SourceTextModule(modStateLibrarySource, { context, identifier: 'claude-code' })
  await state.link(() => { throw new Error('Unexpected state library import') })

  const inside = (path: string) => {
    const child = relative(root, path)
    return child === '' || child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  }
  async function load(path: string): Promise<Module> {
    const canonical = await realpath(path)
    if (!inside(canonical)) throw new Error(`Test import escapes plugin root: ${path}`)
    const known = cache.get(canonical)
    if (known) return known
    const source = await readFile(canonical, 'utf8')
    const loader = canonical.endsWith('x') ? 'tsx' : canonical.endsWith('.ts') ? 'ts' : 'js'
    const transformed = await new Bun.Transpiler({ loader }).transform(source)
    const module = new SourceTextModule(transformed, {
      context,
      identifier: pathToFileURL(canonical).href,
      initializeImportMeta(meta) { meta.url = pathToFileURL(canonical).href },
    })
    cache.set(canonical, module)
    await module.link(async (specifier, referencing) => {
      if (specifier === 'claude-code/testing') return testing
      if (specifier === 'claude-code') return state
      if (!specifier.startsWith('.') && !isAbsolute(specifier))
        throw new Error(`Unsupported test import: ${specifier}`)
      const base = resolve(dirname(new URL(referencing.identifier).pathname), specifier)
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts')]) {
        try { return await load(candidate) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      throw new Error(`Cannot resolve test import ${specifier}`)
    })
    return module
  }
  const entry = await load(file)
  await entry.evaluate()
}

function* elementNodes(tree: unknown): Generator<Record<string, unknown> & { type: string }> {
  if (Array.isArray(tree)) {
    for (const child of tree) yield* elementNodes(child)
  } else if (isRecord(tree) && typeof tree.type === 'string') {
    yield tree as Record<string, unknown> & { type: string }
    if (Array.isArray(tree.children)) yield* elementNodes(tree.children)
  }
}

function describeElement(node: Record<string, unknown> & { type: string }): FoundElement {
  const props = structuredClone(isRecord(node.props) ? node.props : {})
  const children: unknown[] = []
  let text = ''
  for (const child of Array.isArray(node.children) ? node.children : []) {
    if (typeof child === 'string') {
      children.push(child)
      text += child
    } else if (isRecord(child) && typeof child.type === 'string') {
      const description = describeElement(child as Record<string, unknown> & { type: string })
      children.push({type: description.type, props: description.props, children: description.children})
      text += description.text
    }
  }
  const shown = node.type === 'Button' || node.type === 'Link' ? props.label
    : node.type === 'Markdown' ? props.text : node.type === 'Code' ? props.source
    : node.type === 'Input' ? props.value : undefined
  if (typeof shown === 'string' && children.length === 0) text = shown
  return { type: node.type, key: typeof props.key === 'string' ? props.key : undefined, props, text, children }
}

function queryElements(tree: unknown, query: ElementQuery): FoundElement[] {
  if (!isRecord(query)) throw new TypeError('UI element query must be an object')
  if (query.text !== undefined && typeof query.text !== 'string' && !isRegExp(query.text))
    throw new TypeError('UI element query text must be a string or RegExp')
  const pattern = isRegExp(query.text) ? new RegExp(query.text.source, query.text.flags) : undefined
  const found: FoundElement[] = []
  for (const node of elementNodes(tree)) {
    const props = isRecord(node.props) ? node.props : {}
    if (query.type !== undefined && node.type !== query.type || query.key !== undefined && props.key !== query.key) continue
    const element = describeElement(node)
    if (typeof query.text === 'string' && !element.text.includes(query.text)) continue
    if (pattern) {
      pattern.lastIndex = 0
      if (!pattern.test(element.text)) continue
    }
    found.push(element)
  }
  return found
}

function uiHelper(runtime: ReturnType<typeof createModsRuntime>, mounts: Set<MountedUi>) {
  const invalidations = new Set<Promise<void>>()
  // State invalidations are fire-and-forget in production; acts await their actual drawings.
  function trackInvalidation<Args extends unknown[]>(original: (...args: Args) => Promise<void>) {
    return (...args: Args): Promise<void> => {
      const pending = original(...args)
      invalidations.add(pending)
      void pending.then(() => invalidations.delete(pending), () => invalidations.delete(pending))
      return pending
    }
  }
  runtime.ui.invalidate = trackInvalidation(runtime.ui.invalidate.bind(runtime.ui))
  runtime.ui.invalidateInstance = trackInvalidation(runtime.ui.invalidateInstance.bind(runtime.ui))
  return {
    async mount(input: (Omit<ModRenderInput, 'requestId'> & { requestId?: string; plugin?: string }) | ModRenderComponent, props: ModInput = {}): Promise<MountedUi> {
      const request: ModRenderInput = typeof input === 'string'
        ? { surface: 'terminal', component: input, requestId: `test-${mounts.size + 1}`, props }
        : { ...input, requestId: input.requestId ?? `test-${mounts.size + 1}` }
      const defaultPlugin = typeof input === 'string' ? undefined : input.plugin
      delete (request as ModRenderInput & { plugin?: string }).plugin
      let tree: unknown
      let drawing = 0
      let resolveDrawn: (() => void) | undefined
      const drawn = new Promise<void>(resolve => { resolveDrawn = resolve })
      let disposed = false
      const site: ModRenderSite = await runtime.ui.mount(request, {
        surface: request.surface as ModRenderSurface,
        clientClock: 'manual',
        render(nextTree, nextDrawing) { tree = nextTree; drawing = nextDrawing; resolveDrawn?.(); resolveDrawn = undefined },
        unmount() { tree = undefined; resolveDrawn?.(); resolveDrawn = undefined },
      })
      async function act<T>(operation: () => Promise<T>): Promise<T> {
        if (disposed) throw new Error('UI mount is unmounted')
        const result = await operation()
        while (invalidations.size) await Promise.all([...invalidations])
        return result
      }
      async function interact(callback: ModUiCallback, kind: Parameters<ModRenderSite['interact']>[2], key: string, value?: string) {
        return act(() => site.interact(drawing, callback, kind, key, value))
      }
      function callbackFor(target: { key: string; plugin?: string }, type: string): ModUiCallback {
        if (disposed) throw new Error('UI mount is unmounted')
        const plugin = target.plugin ?? defaultPlugin
        const node = [...elementNodes(tree)].find(node => node.type === type && isRecord(node.props) && node.props.key === target.key &&
          isRecord(node.press) && (plugin === undefined || node.press.plugin === plugin))
        if (!node) throw new Error(`UI ${type} not found: ${target.key}`)
        return node.press as ModUiCallback
      }
      function readTree(scope?: { in?: string }): unknown {
        const result = site.getTree(scope)
        if (scope?.in !== undefined && result === undefined) throw new Error(`Client not found: ${scope.in}`)
        return result
      }
      const mounted: MountedUi = {
        surface: request.surface,
        key(...args) { return act(() => site.key(...structuredClone(args))) },
        pointer(...args) { return act(() => site.pointer(...structuredClone(args))) },
        resize(...args) { return act(() => site.resize(...structuredClone(args))) },
        post(...args) { return act(() => site.post(...structuredClone(args))) },
        advance(...args) { return act(() => site.advance(...args)) },
        async press(target) {
          const callback = callbackFor(target, target.link === undefined ? 'Button' : 'Markdown')
          return interact(callback, target.link === undefined ? 'press' : 'link.press', target.key, target.link?.href)
        },
        async input(target) {
          const callback = callbackFor(target, 'Input')
          const kind = target.kind ?? 'submit'
          if (kind !== 'change' && kind !== 'submit') throw new TypeError('UI input kind must be change or submit')
          return interact(callback, `input.${kind}`, target.key, target.text)
        },
        async select(target) {
          return interact(callbackFor(target, 'Select'), 'select', target.key, target.value)
        },
        async drawn(scope) {
          if (disposed) throw new Error('UI mount is unmounted')
          await drawn
          await runtime.settle()
          while (invalidations.size) await Promise.all([...invalidations])
          if (disposed) throw new Error('UI mount is unmounted')
          return structuredClone(readTree(scope))
        },
        async find(query) {
          if (disposed) throw new Error('UI mount is unmounted')
          if (!isRecord(query)) throw new TypeError('UI element query must be an object')
          await runtime.settle()
          while (invalidations.size) await Promise.all([...invalidations])
          if (disposed) throw new Error('UI mount is unmounted')
          return queryElements(readTree(query), query)[0]
        },
        async findAll(query) {
          if (disposed) throw new Error('UI mount is unmounted')
          if (!isRecord(query)) throw new TypeError('UI element query must be an object')
          await runtime.settle()
          while (invalidations.size) await Promise.all([...invalidations])
          if (disposed) throw new Error('UI mount is unmounted')
          return queryElements(readTree(query), query)
        },
        async redraw(nextProps = request.props) {
          if (disposed) throw new Error('UI mount is unmounted')
          request.props = nextProps
          await site.update(request)
        },
        async unmount() {
          if (disposed) return
          disposed = true
          mounts.delete(mounted)
          await site.dispose()
        },
      }
      mounts.add(mounted)
      await drawn
      return mounted
    },
  }
}

function createEngine(
  runtime: ReturnType<typeof createModsRuntime>,
  initialize: () => Promise<void>,
  mounts: Set<MountedUi>,
  session: { sessionId: string; cwd: string },
  signal: AbortSignal,
  track: <T>(operation: () => Promise<T>) => Promise<T>,
): Record<string, unknown> {
  const ui = uiHelper(runtime, mounts)
  const engine: Record<string, unknown> = new Proxy({}, {
    get(_target, noun: string) {
      if (noun === 'classic') return new Proxy({}, {
        get: (_noun, event: string) => event !== 'PreToolUse' && (HOOK_EVENTS as readonly string[]).includes(event)
          ? (input: ModInput = {}) => capability(`classic.${event}`)({
              session_id: session.sessionId, transcript_path: '', cwd: session.cwd,
              ...input, hook_event_name: event,
            })
          : undefined,
      })
      if (noun === 'ui') return new Proxy(ui, {
        get(target, method: string) {
          if (method in target) return (...args: Parameters<typeof target.mount>) => track(async () => {
            await initialize()
            signal.throwIfAborted()
            return target.mount(...args)
          })
          return capability(`ui.${method}`)
        },
      })
      return new Proxy({}, { get: (_noun, method: string) => capability(`${noun}.${method}`) })
    },
  })
  return engine

  function capability(event: string) {
    if (event === 'turn.step') return (input: ModInput = {}) => {
      const pending = track(async () => {
        await initialize()
        signal.throwIfAborted()
        return runtime.stream(event, input,
          // eslint-disable-next-line require-yield -- A rejecting terminal emits no chunks.
          async function* () { throw new Error(`Unhandled plugin test event: ${event}`) },
          { origin: {plugin:'engine', tier:'core'}, signal },
        )
      })
      void pending.catch(() => {})
      return createModHookStream(async (method, value) => (await pending)[method](value))
    }
    return (input: ModInput = {}) => track(async () => {
      await initialize()
      signal.throwIfAborted()
      return runtime.dispatch(event, input, async () => { throw new Error(`Unhandled plugin test event: ${event}`) }, { origin: {plugin:'engine', tier:'core'}, signal })
    })
  }

}

export async function runPluginTestFile(pluginRoot: string, file: string): Promise<PluginTestFileResult> {
  const root = await realpath(resolve(pluginRoot))
  const target = await realpath(resolve(file))
  const child = relative(root, target)
  if (child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
    throw new Error(`Test file is outside plugin root: ${file}`)
  const registry = createRegistry()
  const tests: PluginTestCaseResult[] = []
  try {
    await loadTestFile(target, root, registry)
  } catch (error) {
    for (const handle of registry.timers) { clearTimeout(handle); clearInterval(handle) }
    registry.timers.clear()
    return { file: target, tests: [], loadFailure: failure(error) }
  }
  for (const item of registry.tests) {
    const startedAt = performance.now()
    const messages: string[] = []
    const diagnostics: ModDiagnostic[] = []
    const asynchronous: unknown[] = []
    let registrationId = 0
    const mounts = new Set<MountedUi>()
    let deadline: TimerHandle | undefined
    let initialization: Promise<void> | undefined
    const lifetime = new AbortController()
    const operations = new Set<Promise<unknown>>()
    const track = <T>(operation: () => Promise<T>): Promise<T> => {
      let abort: () => void
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(lifetime.signal.reason)
        lifetime.signal.addEventListener('abort', abort, { once: true })
        if (lifetime.signal.aborted) abort()
      })
      const pending = Promise.race([operation(), cancelled]).finally(() => {
        lifetime.signal.removeEventListener('abort', abort)
        operations.delete(pending)
      })
      operations.add(pending)
      return pending
    }
    const runtime = createModsRuntime({ testing: true, onDiagnostic: event => diagnostics.push(event) })
    const session = { cwd: root, surface: 'terminal' as const, isInteractive: true, sessionId: `plugin-test-${Date.now()}` }
    // The test's tool mocks are core hooks too; register the classic bridge before them.
    runtime.registerHostCallback({
      tier: 'core',
      registration: { id: ++registrationId, event: 'tool.call', matcher: {}, hasCatch: false },
    }, async (_engine, input, next) => {
      const result = await runtime.dispatch('classic.PreToolUse', input, async () => ({}), {
        origin: { plugin: 'engine', tier: 'core' }, signal: next.signal,
      })
      if (isRecord(result) && typeof result.deny === 'string')
        return { isError: true, result: undefined, text: result.deny }
      if (isRecord(result) && isRecord(result.updatedInput)) {
        const args = result.updatedInput
        const reserved = ['tool', 'tool_use_id', 'agentId', 'consent', '$shadowed']
        const shadowed = Object.fromEntries(reserved.filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]))
        const replacement: ModInput = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'agentId' && key !== 'consent'))
        replacement.tool = input.tool
        replacement.tool_use_id = input.tool_use_id
        if (Object.keys(shadowed).length) replacement.$shadowed = shadowed
        for (const key of ['agentId', 'consent']) if (Object.hasOwn(input, key)) replacement[key] = input[key]
        return next(replacement)
      }
      return next(input)
    })
    const reject = (reason: unknown) => asynchronous.push(reason)
    const crash = (reason: unknown) => asynchronous.push(reason)
    process.on('unhandledRejection', reject)
    process.on('uncaughtException', crash)
    try {
      let started = false
      const initialize = () => {
        lifetime.signal.throwIfAborted()
        started = true
        return initialization ??= (async () => {
          // No settings shell hooks run in tests; an unhandled classic chain is empty.
          runtime.registerHostCallback({
            tier: 'core',
            registration: { id: ++registrationId, event: 'classic.*', matcher: {}, hasCatch: false },
          }, () => ({}))
          const plugins = [await pluginInput(root, registry.tier, item.options.options)]
          if (item.options.plugins?.length) {
            const directory = join(root, '.claude-test-environment')
            await mkdir(directory, { recursive: true })
            const inlineRoot = await mkdtemp(join(directory, 'inline-'))
            for (const [index, plugin] of item.options.plugins.entries()) {
              if (plugins.some(input => input.name === plugin.name)) throw new Error(`Duplicate test plugin: ${plugin.name}`)
              const entrypoint = join(inlineRoot, `${index}.ts`)
              const source = Function.prototype.toString.call(plugin.register)
              // Object methods need a function keyword; arrows and function expressions do not.
              const expression = /^(?:async\s+)?register\s*\(/.test(source)
                ? source.replace(/^(async\s+)?register/, '$1function register') : source
              await writeFile(entrypoint, `export const register = ${expression}\n`)
              plugins.push({name: plugin.name, storageId: `${plugin.name}@test`, pluginRoot: inlineRoot,
                entrypoints: [entrypoint], tier: plugin.tier ?? 'user', options: {}})
            }
          }
          lifetime.signal.throwIfAborted()
          await runtime.reconcile(plugins)
          lifetime.signal.throwIfAborted()
          await runtime.bind(session)
        })()
      }
      const engine = createEngine(runtime, initialize, mounts, session, lifetime.signal, track)
      const on: TestOn = (event, matcherOrHandler, handler) => {
        if (started) throw new Error('on() must be called synchronously before the first await in a plugin test')
        const callback = typeof matcherOrHandler === 'function' ? matcherOrHandler : handler
        if (typeof callback !== 'function') throw new TypeError('on requires a hook callback')
        runtime.registerHostCallback({
          tier: 'core',
          registration: { id: ++registrationId, event, matcher: typeof matcherOrHandler === 'function' ? {} : matcherOrHandler, hasCatch: false },
        }, (engine, input, next) => {
          const result = callback(engine, input, next)
          // Render validation requires host-realm plain data, not VM prototypes.
          return next.event === 'ui.render' ? Promise.resolve(result).then(value => structuredClone(value)) : result
        })
      }
      queueMicrotask(() => { started = true })
      const body = Promise.resolve(item.body(engine, on))
      await Promise.race([
        body,
        new Promise<never>((_, rejectTimeout) => {
          deadline = setTimeout(() => rejectTimeout(new Error(`Test timed out after ${item.timeout}ms`)), item.timeout)
        }),
      ])
      if (registry.timers.size) throw new Error(`Test left ${registry.timers.size} timer(s) pending`)
      if (mounts.size) throw new Error(`Test left ${mounts.size} UI mount(s) active; call ui.unmount()`)
    } catch (error) {
      messages.push(failure(error))
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      try {
        for (const handle of registry.timers) { clearTimeout(handle); clearInterval(handle) }
        registry.timers.clear()
        // Fence engine continuations before disposal; held user stubs are not a join barrier.
        const pendingOperations = [...operations]
        for (const pending of pendingOperations) void pending.catch(error => asynchronous.push(error))
        const initializing = initialization?.catch(error => {
          // Completed operations already delivered initialization errors to their caller.
          if (pendingOperations.length && !asynchronous.includes(error)) asynchronous.push(error)
        })
        lifetime.abort(new Error('Plugin test ended with pending operation'))
        for (const mount of mounts) {
          try { await mount.unmount() } catch (error) {
            messages.push(`unmount: ${failure(error)}`)
          }
        }
        try { await runtime.dispose() } catch (error) {
          messages.push(`dispose: ${failure(error)}`)
        }
        await initializing
        await Promise.allSettled(pendingOperations)
        // Flush this turn's rejection notifications after teardown, not a timed grace period.
        await new Promise<void>(resolve => setImmediate(resolve))
        for (const event of diagnostics)
          messages.push(`${event.plugin} ${event.stage}: ${event.message}`)
        for (const error of asynchronous)
          messages.push(failure(error))
      } finally {
        process.off('unhandledRejection', reject)
        process.off('uncaughtException', crash)
      }
    }
    tests.push({
      name: item.name,
      durationMs: performance.now() - startedAt,
      ...(messages.length ? { failure: messages.join('\n') } : {}),
    })
  }
  for (const handle of registry.timers) { clearTimeout(handle); clearInterval(handle) }
  registry.timers.clear()
  return { file: target, tests }
}

export async function runPluginTestChild(pluginRoot: string, file: string): Promise<number> {
  const result = await runPluginTestFile(pluginRoot, file)
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result)}\n`)
  return result.loadFailure !== undefined || result.tests.some(test => test.failure !== undefined) ? 1 : 0
}

export async function runPluginTests(
  pluginRoot: string,
  options: { childCommand?: (file: string) => string[]; fileTimeoutMs?: number } = {},
): Promise<PluginTestResult> {
  const fileTimeoutMs = options.fileTimeoutMs ?? 60_000
  if (!Number.isFinite(fileTimeoutMs) || fileTimeoutMs <= 0)
    throw new TypeError('fileTimeoutMs must be a positive finite number')
  const startedAt = performance.now()
  const root = await realpath(resolve(pluginRoot))
  const files = await filesUnder(root)
  if (!files.length) throw new Error(`No plugin test files found under ${root}`)
  const results: PluginTestFileResult[] = []
  for (const file of files) {
    const command = options.childCommand?.(file) ?? [process.execPath, import.meta.path, '--child', root, file]
    // Do not inherit credentials, runtime preload flags, or arbitrary plugin environment.
    const isolationRoot = join(root, '.claude-test-environment')
    await mkdir(isolationRoot, { recursive: true })
    const home = await mkdtemp(join(isolationRoot, 'home-'))
    const env: Record<string, string> = { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'config'), TMPDIR: home, TEMP: home, TMP: home }
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'TZ']) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    const child = Bun.spawn(command, { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, fileTimeoutMs)
    let output: [string, string, number]
    try {
      output = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
    } finally {
      clearTimeout(deadline)
    }
    const [stdout, stderr, status] = output
    if (timedOut) {
      results.push({ file, tests: [], loadFailure: `Plugin test file timed out after ${fileTimeoutMs}ms` })
      continue
    }
    const line = stdout.split('\n').find(value => value.startsWith(RESULT_MARKER))
    if (!line) {
      results.push({ file, tests: [], loadFailure: stderr || stdout || `Child exited with status ${status}` })
      continue
    }
    try {
      const result = JSON.parse(line.slice(RESULT_MARKER.length)) as PluginTestFileResult
      if (result.file !== file || !Array.isArray(result.tests) || result.tests.some(entry =>
        !isRecord(entry) || typeof entry.name !== 'string' || typeof entry.durationMs !== 'number' ||
        !Number.isFinite(entry.durationMs) || entry.durationMs < 0 ||
        entry.failure !== undefined && typeof entry.failure !== 'string') ||
        result.loadFailure !== undefined && typeof result.loadFailure !== 'string')
        throw new Error('Invalid child test result')
      if (status !== 0 && result.loadFailure === undefined && result.tests.every(test => test.failure === undefined)) {
        result.tests = []
        result.loadFailure = `Child exited with status ${status}${stderr ? `\n${stderr}` : ''}`
      }
      results.push(result)
    } catch (error) {
      results.push({ file, tests: [], loadFailure: failure(error) })
    }
  }
  return {
    files: results,
    passed: results.reduce((sum, result) => sum + result.tests.filter(test => test.failure === undefined).length, 0),
    failed: results.reduce((sum, result) => sum + result.tests.filter(test => test.failure !== undefined).length + (result.loadFailure === undefined ? 0 : 1), 0),
    durationMs: performance.now() - startedAt,
  }
}

if (import.meta.main && process.argv[2] === '--child') {
  try {
    const [, , , root, file] = process.argv
    if (!root || !file) throw new Error('Usage: runner.ts --child <plugin-root> <test-file>')
    process.exitCode = await runPluginTestChild(root, file)
  } catch (error) {
    console.error(failure(error))
    process.exitCode = 1
  }
}
