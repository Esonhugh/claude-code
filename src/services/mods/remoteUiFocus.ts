import { isDeepStrictEqual } from 'node:util'
import { logForDebugging } from '../../utils/debug.js'
import type { SDKControlUIFocusRequest, SDKControlUIFocusResponse, SDKControlUIRenderRequest, SDKUIElementAddress, SDKUIFocusMessage, SDKUIScrollComponent } from '../../entrypoints/sdk/modsControlTypes.js'
import type { ModInput, ModOrigin } from './types.js'
import type { createModRemoteScroll } from './remoteUiScroll.js'

type View = { component: SDKUIScrollComponent; id: string; held: boolean; holder?: SDKUIElementAddress; elements: SDKUIElementAddress[]; reporting: boolean; queue: ReturnType<typeof reports> }
type Contract = { validateInput(input: ModInput, received: ModInput): void; restoreInput(input: ModInput, received: ModInput): ModInput }
/** Reports retain one pending aggregate, including its last explicitly named landing. */
function reports(work: (input: SDKControlUIFocusRequest) => Promise<SDKControlUIFocusResponse>) {
  let running = false
  let pending: { input: SDKControlUIFocusRequest; resolve(value: SDKControlUIFocusResponse): void; reject(error: unknown): void; promise: Promise<SDKControlUIFocusResponse> } | undefined
  async function run(input: SDKControlUIFocusRequest): Promise<SDKControlUIFocusResponse> {
    running = true
    try { return await work(input) }
    finally {
      const next = pending; pending = undefined
      if (next) void run(next.input).then(next.resolve, next.reject)
      else running = false
    }
  }
  return { take(input: SDKControlUIFocusRequest) {
    if (!running) return run(input)
    if (pending) {
      const old = pending.input
      pending.input = input.element === undefined && input.is_held && old.element !== undefined ? { ...input, element: old.element, by: old.by } : input
      return pending.promise
    }
    const deferred = Promise.withResolvers<SDKControlUIFocusResponse>()
    pending = { input, ...deferred }; return deferred.promise
  } }
}
export function createModRemoteFocus(options: {
  scroll: ReturnType<typeof createModRemoteScroll>
  panes(): { panes: readonly { id: string; plugin: string }[]; focusedId: string | null; shownId: string | null; focusRequestedId: string | null }
  attached(clientId: string): boolean
  placed(): boolean
  subscribe(listener: () => void): () => void
  dispatch(input: ModInput, core: (input: ModInput) => Promise<unknown>, origin: ModOrigin | undefined, contract: Contract, signal?: AbortSignal): Promise<unknown>
}) {
  const views = new Map<string, View>(), changes = new Set<() => void>(), listeners = new Set<(message: Omit<SDKUIFocusMessage, 'uuid' | 'session_id'>) => void>()
  const keyOf = (component: string, id: string) => `${component}:${id}`
  const valid = (component: SDKUIScrollComponent, id: string) => component === 'AbovePrompt' ? id === 'above-prompt' : options.panes().panes.some(p => p.id === id)
  const notify = () => { for (const listener of changes) listener() }
  function lookup(component: SDKUIScrollComponent, id: string): View | undefined {
    if (!valid(component, id) || !options.scroll.site(component, id)) return undefined
    const key = keyOf(component, id)
    let view = views.get(key)
    if (!view) {
      const created: View = { component, id, held: false, elements: [], reporting: false, queue: reports(input => report(created, input)) }
      views.set(key, created); view = created
    }
    return view
  }
  const current = (view: View) => lookup(view.component, view.id) === view
  const outcome = (view: View | undefined, result: { deny?: string } = {}): SDKControlUIFocusResponse => ({ moved: result.deny === undefined, element: view?.holder ?? null, ...result })
  const contract: Contract = {
    restoreInput(input, received) {
      const restored = { ...input }
      for (const key of ['component', 'requestId', 'plugin', 'origin', 'element']) if (!Object.hasOwn(restored, key) && Object.hasOwn(received, key)) restored[key] = received[key]
      return restored
    },
    validateInput(input, received) {
      for (const key of ['component', 'requestId', 'plugin', 'origin']) if (!isDeepStrictEqual(input[key], received[key])) throw new TypeError(`Mod UI focus cannot rewrite ${key}`)
      if (received.element === undefined ? input.element !== undefined : typeof input.element !== 'string' || input.element.length === 0) throw new TypeError('Mod UI focus cannot add or remove an element')
    },
  }
  async function move(view: View, input: ModInput, actor?: ModOrigin, signal?: AbortSignal): Promise<{ deny?: string }> {
    const result = await options.dispatch(input, async next => {
      if (signal?.aborted) return { deny: 'the move was abandoned' }
      if (!current(view)) return { deny: 'no such site' }
      const origin = next.origin as { kind: 'person' } | { kind: 'plugin'; name: string }
      const owner = view.component === 'Pane' ? options.panes().panes.find(p => p.id === view.id)?.plugin : undefined
      if (origin.kind === 'plugin' && owner !== undefined && owner !== origin.name && next.plugin !== origin.name) return { deny: "not this plugin's site" }
      if (!view.held) return { deny: 'that site does not hold the keyboard' }
      if (origin.kind === 'plugin' && view.holder && view.holder.plugin !== origin.name) return { deny: "another plugin's element holds the keyboard" }
      if (next.plugin === undefined || next.element === undefined) view.holder = undefined
      else {
        if (!view.elements.some(e => e.plugin === next.plugin && e.key === next.element)) return { deny: `no element of ${next.plugin} is drawn under that key` }
        view.holder = { plugin: next.plugin as string, key: next.element as string }
        if (origin.kind === 'plugin' && !view.reporting) {
          const client = options.scroll.site(view.component, view.id)!
          for (const listener of listeners) listener({ type: 'system', subtype: 'ui_focus', client_id: client.clientId, component: view.component, instance_id: view.id, ...view.holder })
        }
      }
      notify(); return {}
    }, actor, contract, signal) as { deny?: string }
    logForDebugging(`[ModsUIRemote] ui.focus component=${view.component} instance=${JSON.stringify(view.id)} client=${options.scroll.site(view.component, view.id)?.clientId} origin=${(input.origin as {kind:string}).kind} plugin=${JSON.stringify(input.plugin)} key=${JSON.stringify(input.element)} deny=${JSON.stringify(result.deny)}`)
    return result
  }
  async function report(view: View, request: SDKControlUIFocusRequest): Promise<SDKControlUIFocusResponse> {
    if (!current(view)) return outcome(undefined, { deny: 'no such site' })
    view.held = request.is_held
    if (!view.held) view.holder = undefined
    view.reporting = true; notify()
    try {
      const element = request.element
      const result = element !== undefined && request.is_held ? await move(view, { component: view.component, requestId: view.id, ...(element ? { plugin: element.plugin, element: element.key } : {}), origin: request.by === 'auto' && element ? { kind: 'plugin', name: element.plugin } : { kind: 'person' } }) : {}
      return outcome(current(view) ? view : undefined, result)
    } finally { view.reporting = false; notify() }
  }
  return {
    subscribe(listener: (message: Omit<SDKUIFocusMessage, 'uuid' | 'session_id'>) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    reconcile() { for (const [key, view] of views) if (!valid(view.component, view.id) || !options.scroll.site(view.component, view.id)) views.delete(key); notify() },
    observeRequest(request: SDKControlUIRenderRequest) {
      if (request.component !== 'Pane' && request.component !== 'AbovePrompt') return
      const view = lookup(request.component, request.instance_id)
      if (view && typeof request.props.isFocused === 'boolean') { view.held = request.props.isFocused; notify() }
    },
    observe(request: SDKControlUIRenderRequest, tree?: unknown) {
      if (request.component !== 'Pane' && request.component !== 'AbovePrompt') return
      const view = lookup(request.component, request.instance_id); if (!view) return
      const elements: SDKUIElementAddress[] = []
      function visit(value: any) {
        if (!value || typeof value !== 'object') return
        const plugin = value.press?.plugin
        if (['Button', 'Input', 'Select'].includes(value.type) && typeof plugin === 'string' && typeof value.props?.key === 'string') elements.push({ plugin, key: value.props.key })
        for (const child of value.children ?? []) visit(child)
      }
      visit(tree); view.elements = elements
      if (view.holder && !elements.some(e => e.plugin === view.holder!.plugin && e.key === view.holder!.key)) view.holder = undefined
      notify()
    },
    report(request: SDKControlUIFocusRequest) {
      const clientId = request.client_id ?? `${request.surface ?? 'desktop'}:default`
      if (!valid(request.component, request.instance_id) || !options.scroll.site(request.component, request.instance_id) && !options.attached(clientId)) return Promise.resolve(outcome(undefined, { deny: 'no such site' }))
      options.scroll.ensureSite(request.component, request.instance_id, clientId)
      return lookup(request.component, request.instance_id)!.queue.take(request)
    },
    syncPanes(clientId?: string) {
      for (const pane of options.panes().panes) {
        const held = options.panes().focusedId === pane.id
        if (held && clientId && options.attached(clientId)) options.scroll.ensureSite('Pane', pane.id, clientId)
        const view = lookup('Pane', pane.id)
        if (view) { view.held = held; if (!held) view.holder = undefined }
      }
      notify()
    },
    async focus(actor: ModOrigin, request: { requestId: string; key: string }, abovePrompt: boolean, signal?: AbortSignal, rootEvent?: string): Promise<{ deny?: string }> {
      const eligible = () => options.panes().panes.some(p => p.id === request.requestId && p.plugin === actor.plugin) ? 'Pane' as const : request.requestId === 'above-prompt' && abovePrompt ? 'AbovePrompt' as const : undefined
      const settled = () => {
        const component = eligible(), view = component && lookup(component, request.requestId), state = options.panes()
        const handoff = state.focusRequestedId === request.requestId && lookup('AbovePrompt', 'above-prompt') !== undefined
        if (!component || rootEvent === 'ui.render' || rootEvent === 'ui.focus' || (component === 'Pane' ? !options.placed() || state.shownId !== request.requestId && !handoff : !view)) return true
        return !!view && !handoff && (!view.held || !!view.holder && view.holder.plugin !== actor.plugin || view.elements.some(e => e.plugin === actor.plugin && e.key === request.key))
      }
      if (!settled() && !signal?.aborted) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); changes.delete(check); stop(); signal?.removeEventListener('abort', finish); resolve() }
        const check = () => { if (settled()) finish() }
        const timer = setTimeout(finish, 3000), stop = options.subscribe(check)
        changes.add(check); signal?.addEventListener('abort', finish, { once: true }); check()
      })
      const component = eligible(), view = component && lookup(component, request.requestId)
      if (!view) return { deny: "not this plugin's site" }
      if (!view.held) return { deny: 'that site does not hold the keyboard' }
      if (view.holder && view.holder.plugin !== actor.plugin) return { deny: "another plugin's element holds the keyboard" }
      if (!view.elements.some(e => e.plugin === actor.plugin && e.key === request.key)) return { deny: 'no element of its own is drawn under that key' }
      return move(view, { component, requestId: view.id, plugin: actor.plugin, element: request.key, origin: { kind: 'plugin', name: actor.plugin } }, actor, signal)
    },
    dispose() { views.clear(); notify(); changes.clear(); listeners.clear() },
  }
}
