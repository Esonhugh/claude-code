import { isDeepStrictEqual } from 'node:util'
import {
  createModRemoteClientRegistry,
  modClientDataProblem,
} from './remoteUiClient.js'
import type {
  SDKControlUIRenderRequest,
  SDKControlUIRenderResponse,
  SDKControlUIPressRequest,
  SDKControlUIInputRequest,
  SDKControlUISelectRequest,
  SDKControlUIInputResponse,
  SDKControlUIClientPressRequest,
  SDKControlUIClientPressResponse,
  SDKControlUIMessageRequest,
  SDKControlUIMessageResponse,
  SDKUIRenderElement,
} from '../../entrypoints/sdk/modsControlTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ModsRuntime } from './runtime.js'
import type { ModInput } from './types.js'
import type { ModRenderInput, ModRenderSite } from './ui.js'

const transcript = new Set([
  'UserMessage',
  'AssistantMessage',
  'ToolUse',
  'ToolResult',
  'ToolGroup',
  'CommandOutput',
  'TurnDuration',
  'InfoNotice',
])
export function normalizeModRemoteRender(
  request: SDKControlUIRenderRequest,
): ModRenderInput {
  const props = structuredClone(request.props)
  if (typeof props.output === 'string' && props.output.length > 65536) {
    let text = props.output.slice(0, 65536)
    const end = text.charCodeAt(text.length - 1)
    if (end >= 0xd800 && end <= 0xdbff) text = text.slice(0, -1)
    props.output = Buffer.from(text, 'utf16le').toString('utf16le')
  }
  if (
    ['ToolUse', 'ToolResult'].includes(request.component) &&
    typeof props.tool_use_id !== 'string'
  )
    props.tool_use_id = request.instance_id
  if (transcript.has(request.component)) {
    delete props.onScreen
    if (request.on_screen !== undefined)
      props.onScreen = structuredClone(request.on_screen)
  }
  return {
    surface: request.surface,
    component: request.component,
    requestId: request.instance_id,
    props,
    ...(request.viewport === undefined
      ? {}
      : { viewport: structuredClone(request.viewport) }),
  }
}

function firstEngine(value: any): number | undefined {
  if (!value || typeof value !== 'object') return
  if (value.type === 'engine') return value.ref === 0 ? undefined : value.ref
  if (['Button', 'Input', 'Select'].includes(value.type)) return
  for (const child of value.children ?? []) {
    const ref = firstEngine(child)
    if (ref !== undefined) return ref
  }
}

function wireTree(value: any): any {
  if (!value || typeof value !== 'object') return value
  const node = { ...value }
  if (node.type === 'Client') {
    node.client = { plugin: node.group.plugin }
    delete node.group
  } else if (['Button', 'Input', 'Select'].includes(node.type))
    delete node.group
  if (
    ['Box', 'Text', 'div', 'span', 'b'].includes(node.type) &&
    node.props &&
    Object.keys(node.props).length === 0
  )
    delete node.props
  if (Array.isArray(node.children)) node.children = node.children.map(wireTree)
  return node
}

type Drawing = {
  input: ModRenderInput
  version: number
  site?: ModRenderSite
  ready?: Promise<ModRenderSite>
  tree?: unknown
  drawing?: number
  selectedProps?: ModInput
  rewritten?: boolean
  settled?: boolean
}

/** Drawing leases, callbacks and Client snapshots belong to this SDK loop. */
export function createModRemoteRenderer(runtime: ModsRuntime) {
  const sites = new Map<string, Drawing>()
  const retiring = new Set<Promise<void>>()
  const clients = createModRemoteClientRegistry()
  const queues = new Map<string, Promise<unknown>>()
  const serial = <T>(
    kind: string,
    plugin: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    const key = `${kind}\0${plugin}`
    const result = (queues.get(key) ?? Promise.resolve()).then(work, work)
    queues.set(key, result)
    void result
      .finally(() => {
        if (queues.get(key) === result) queues.delete(key)
      })
      .catch(() => {})
    return result
  }
  let disposed = false
  const remove = async (key: string, entry: Drawing) => {
    if (sites.get(key) === entry) sites.delete(key)
    await entry.ready?.catch(() => {})
    await entry.site?.dispose()
  }
  const retire = (key: string, entry: Drawing) => {
    const work = remove(key, entry)
    retiring.add(work)
    void work
      .finally(() => retiring.delete(work))
      .catch((error) =>
        logForDebugging(`[ModsUIRemote] release failed: ${String(error)}`),
      )
  }
  return {
    async render(
      request: SDKControlUIRenderRequest,
    ): Promise<SDKControlUIRenderResponse> {
      if (disposed) throw new Error('Remote UI renderer is disposed')
      const input = normalizeModRemoteRender(request)
      const clientGeneration =
        input.surface === 'desktop'
          ? clients.begin(input.component, input.requestId)
          : undefined
      runtime.remoteClients.attach({
        surface: request.surface,
        clientId: request.client_id ?? `${request.surface}:default`,
        ...(request.viewport === undefined
          ? {}
          : { viewport: request.viewport }),
      })
      const key = `${input.surface}\0${input.component}\0${input.requestId}`
      let entry = sites.get(key)
      const hooked = runtime.renderHooks.matchesComponent(input.component)
      if (!runtime.renderHooks.matches(input)) {
        if (entry) await remove(key, entry)
        if (clientGeneration)
          clients.record(clientGeneration, { type: 'engine', ref: 0 })
        return {
          tree: { type: 'engine', ref: 0 },
          props: input.props,
          rewritten: false,
          hooked,
          ...(request.bench === undefined ? {} : { bench: request.bench }),
        }
      }
      const version = runtime.renderHooks.getSnapshot()
      const cached =
        entry?.settled &&
        entry.version === version &&
        input.requestId !== '' &&
        isDeepStrictEqual(
          { ...input, viewport: { ...input.viewport, rows: undefined } },
          {
            ...entry.input,
            viewport: { ...entry.input.viewport, rows: undefined },
          },
        )
      if (!cached) {
        const previous = entry
        if (!previous && sites.size >= 500) {
          const [oldKey, old] = sites.entries().next().value!
          retire(oldKey, old)
        }
        const drawing: Drawing = { input, version }
        sites.set(key, drawing)
        entry = drawing
        // A newer request replaces callback ownership but does not cancel the older hook.
        if (previous) retire(key, previous)
        drawing.ready = runtime.ui.mount(input, {
          surface: input.surface,
          clientId: request.client_id,
          externalClients: true,
          onMount: (site) => {
            drawing.site = site
          },
          render: (tree, lease, resolve) => {
            drawing.tree = tree
            drawing.drawing = lease
            const ref = firstEngine(tree)
            drawing.rewritten = ref !== undefined
            drawing.selectedProps =
              ref === undefined ? input.props : resolve(ref)
          },
          unmount: () => {
            if (sites.get(key) === drawing) sites.delete(key)
          },
        })
        try {
          await drawing.ready
          drawing.settled = true
        } catch (error) {
          if (sites.get(key) === drawing) sites.delete(key)
          throw error
        }
      }
      const tree = wireTree(entry!.tree) as SDKUIRenderElement
      if (clientGeneration) clients.record(clientGeneration, tree)
      const props = structuredClone(entry!.selectedProps!)
      const rewritten = entry!.rewritten === true
      const modules: Record<string, string> = {}
      const collect = (node: any) => {
        if (!node || typeof node !== 'object') return
        if (node.type === 'Client') {
          const bundle = runtime.clientModule(node.client.plugin)
          if (bundle) modules[node.client.plugin] = bundle.hash
        } else for (const child of node.children ?? []) collect(child)
      }
      collect(tree)
      logForDebugging(
        `[ModsUIRemote] render surface=${input.surface} component=${input.component} instance=${JSON.stringify(input.requestId)} drawing=${entry.drawing} hooked=${hooked} rewritten=${rewritten}`,
      )
      return {
        tree,
        props,
        rewritten,
        hooked,
        ...(Object.keys(modules).length ? { client_modules: modules } : {}),
        ...(request.bench === undefined ? {} : { bench: request.bench }),
      }
    },
    async interact(
      request:
        | SDKControlUIPressRequest
        | SDKControlUIInputRequest
        | SDKControlUISelectRequest,
    ): Promise<SDKControlUIInputResponse> {
      const kind =
        request.subtype === 'ui_input'
          ? request.kind === 'submit'
            ? 'input.submit'
            : 'input.change'
          : request.subtype === 'ui_select'
            ? 'select'
            : request.href === undefined
              ? 'press'
              : 'link.press'
      const tag = kind.startsWith('input.')
        ? 'Input'
        : kind === 'select'
          ? 'Select'
          : kind === 'link.press'
            ? 'Markdown'
            : 'Button'
      const surface = request.surface ?? 'desktop'
      for (const entry of sites.values()) {
        if (
          entry.input.surface !== surface ||
          !entry.site ||
          entry.drawing === undefined
        )
          continue
        if (
          'component' in request &&
          request.component !== undefined &&
          request.component !== entry.input.component
        )
          continue
        if (
          'instance_id' in request &&
          request.instance_id !== undefined &&
          request.instance_id !== entry.input.requestId
        )
          continue
        let element: string | undefined
        const find = (node: any) => {
          if (!node || typeof node !== 'object' || element !== undefined) return
          if (
            node.type === tag &&
            node.press?.plugin === request.plugin &&
            node.press.handle === request.handle &&
            (request.key === undefined || node.props.key === request.key)
          )
            element = node.props.key
          for (const child of node.children ?? []) find(child)
        }
        find(entry.tree)
        if (element === undefined) continue
        const value = 'value' in request ? request.value : request.href
        const result = await entry.site.interact(
          entry.drawing,
          { plugin: request.plugin, handle: request.handle },
          kind,
          element,
          value,
        )
        const reached = result as { element?: string; value?: string }
        return {
          handled: true,
          ...(reached.element === undefined
            ? {}
            : { element: reached.element }),
          ...(request.subtype === 'ui_press' || reached.value === undefined
            ? {}
            : { value: reached.value }),
        }
      }
      return { handled: false }
    },
    async clientPress(
      request: SDKControlUIClientPressRequest,
    ): Promise<SDKControlUIClientPressResponse> {
      if (!clients.has(request)) {
        logForDebugging(
          `[ModsUIRemote] ui.${request.event.type}: no desktop Client ${request.plugin}/${request.client} (${request.module}) in ${request.component} ${JSON.stringify(request.instance_id)}`,
        )
        return { handled: false }
      }
      const input: ModInput = {
        plugin: request.plugin,
        element: request.element,
        component: request.component,
        requestId: request.instance_id,
        surface: 'desktop',
        ...(request.event.type === 'input'
          ? { kind: request.event.kind, value: request.event.value }
          : request.event.type === 'select'
            ? { value: request.event.value }
            : {}),
      }
      const run = async () => {
        const started = performance.now()
        const result = await runtime.remoteClientPress(
          input,
          request.event.type,
        )
        logForDebugging(
          `[ModsUIRemote] ui.${request.event.type} ${request.plugin}/${request.element} in Client ${request.client} (${request.module}) of ${request.component}: settledMs=${(performance.now() - started).toFixed(1)} ${result.reached ? 'reached' : 'withheld'}`,
        )
        return { handled: true, ...result }
      }
      return request.event.type === 'press'
        ? run()
        : serial(request.event.type, request.plugin, run)
    },
    async clientMessage(
      request: SDKControlUIMessageRequest,
    ): Promise<SDKControlUIMessageResponse> {
      if (!clients.has(request)) {
        logForDebugging(
          `[ModsUIRemote] ui.message: no desktop Client ${request.plugin}/${request.client} (${request.module}) in ${request.component} ${JSON.stringify(request.instance_id)}`,
        )
        return { handled: false }
      }
      const problem = modClientDataProblem(request.data)
      if (problem)
        throw new Error(
          `${request.plugin}: Client ${request.module}: post: the data ${problem}; not sent`,
        )
      return serial('message', request.plugin, async () => {
        const started = performance.now()
        const result = await runtime.remoteClientMessage(request.plugin, {
          surface: 'desktop',
          component: request.component,
          requestId: request.instance_id,
          element: request.client,
          module: request.module,
          data: structuredClone(request.data),
        })
        logForDebugging(
          `[ModsUIRemote] ui.message ${request.plugin}/${request.client} (${request.module}) in ${request.component}: settledMs=${(performance.now() - started).toFixed(1)}`,
        )
        return {
          handled: true,
          ...(result?.props === undefined ? {} : { props: result.props }),
        }
      })
    },
    async dispose() {
      disposed = true
      clients.clear()
      await Promise.all([...sites].map(([key, entry]) => remove(key, entry)))
      await Promise.all([...retiring])
    },
  }
}
