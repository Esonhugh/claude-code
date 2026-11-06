import { createContext, type PointerEvent, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import type { MessageKey } from '../i18n'
import type { HostRequest } from './BackgroundPanes'
import { MOD_CLIENT, MOD_SURFACE, ModNode, modStyle, useGrid } from './Mods'

type T = (key: MessageKey, vars?: Record<string, string>) => string

/** Where a drawing that holds a `Client` sits: the site the session addresses its posts by. */
export type ModClientSiteInfo = {
  request: HostRequest
  component: string
  instanceId: string
  /** Per plugin, the hash of the Client bundle the session drew against (`client_modules`). */
  hashes?: Record<string, string>
}
export const ModClientSite = createContext<ModClientSiteInfo | undefined>(undefined)

type Bundle = {
  hash: string
  modules: { module: string; entry: string; component: string }[]
  limits: { nodes: number; depth: number; chars: number }
  files: { key: string; source: string }[]
}
type Listener = {
  tree: (text: string) => void
  post: (text: string) => void
  fault: (phase: string, reason: string) => void
}
type WireNode = string | { type: string; props?: Record<string, unknown>; children?: WireNode[]; press?: { plugin: string; handle: number } }

const ELEMENTS = new Set(['Box', 'Text', 'Button', 'Input', 'Select', 'Link', 'Code', 'Markdown'])
let nextId = 0

/**
 * One Mod's Client code on this page: a hidden sandboxed frame (served by the
 * session's server under a policy with no network) whose Worker runs it.
 * Only plain data crosses, over a MessagePort the page handed it.
 */
class ModFrame {
  readonly listeners = new Map<number, Listener>()
  limits = { nodes: 20000, depth: 32, chars: 100000 }
  private port?: MessagePort
  private queue: unknown[] = []
  private iframe?: HTMLIFrameElement
  private idle = 0
  dead = false

  constructor(
    readonly plugin: string,
    readonly hash: string | undefined,
    readonly request: HostRequest,
  ) {
    void request({ subtype: 'ui_client_module', plugin }).then(
      res => this.open(res as Bundle),
      (err: unknown) => this.failAll('load', err instanceof Error ? err.message : String(err)),
    )
  }

  private open(bundle: Bundle) {
    if (this.dead) return
    if (this.hash && bundle.hash !== this.hash) return this.failAll('load', 'the Mod changed while its Client loaded')
    this.limits = bundle.limits
    const iframe = document.createElement('iframe')
    iframe.className = 'mod-frame'
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.tabIndex = -1
    iframe.src = '/mods-frame'
    iframe.addEventListener('load', () => {
      if (this.dead || this.port) return
      const channel = new MessageChannel()
      this.port = channel.port1
      this.port.onmessage = e => this.receive(e.data)
      // The frame's origin is opaque, so it cannot be named; it is ours, freshly loaded.
      iframe.contentWindow?.postMessage('claude-mods-frame', '*', [channel.port2])
      this.port.postMessage({ op: 'load', bundle: { files: bundle.files, modules: bundle.modules, limits: bundle.limits } })
      for (const msg of this.queue) this.port.postMessage(msg)
      this.queue = []
    })
    document.body.appendChild(iframe)
    this.iframe = iframe
  }

  private receive(msg: unknown) {
    if (!msg || typeof msg !== 'object') return
    const { op, id, text, phase, reason } = msg as Record<string, unknown>
    const listener = typeof id === 'number' ? this.listeners.get(id) : undefined
    if (!listener) return
    if (op === 'tree' && typeof text === 'string') listener.tree(text)
    else if (op === 'post' && typeof text === 'string') listener.post(text)
    else if (op === 'fault') listener.fault(String(phase), String(reason))
  }

  private failAll(phase: string, reason: string) {
    for (const listener of this.listeners.values()) listener.fault(phase, reason)
  }

  send(msg: { op: string; id: number; [key: string]: unknown }) {
    if (this.dead) return
    if (this.port) this.port.postMessage(msg)
    else this.queue.push(msg)
  }

  mount(listener: Listener, msg: Record<string, unknown>): number {
    const id = ++nextId
    clearTimeout(this.idle)
    this.listeners.set(id, listener)
    this.send({ ...msg, op: 'mount', id })
    return id
  }

  unmount(id: number) {
    if (!this.listeners.delete(id)) return
    this.send({ op: 'unmount', id })
    if (!this.listeners.size) this.idle = window.setTimeout(() => !this.listeners.size && this.close(), 10_000)
  }

  close() {
    this.dead = true
    this.port?.close()
    this.iframe?.remove()
    const map = frames.get(this.request)
    if (map?.get(this.plugin) === this) map.delete(this.plugin)
  }
}

const frames = new Map<HostRequest, Map<string, ModFrame>>()

function frameFor(request: HostRequest, plugin: string, hash: string | undefined): ModFrame {
  let map = frames.get(request)
  if (!map) frames.set(request, (map = new Map()))
  const known = map.get(plugin)
  if (known && !known.dead && (!hash || !known.hash || known.hash === hash)) return known
  known?.close()
  const frame = new ModFrame(plugin, hash, request)
  map.set(plugin, frame)
  return frame
}

/** A Client's tree as the page draws it: known elements only, within the bundle's bounds, presses by handle. */
export function clientTree(text: string, plugin: string, limits: { nodes: number; depth: number; chars: number }): WireNode {
  if (text.length > limits.chars) throw new Error(`a tree serializing to more than ${limits.chars} characters`)
  let count = 0
  const walk = (node: unknown, depth: number): WireNode | null => {
    if (typeof node === 'string') return node
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null
    if (++count > limits.nodes) throw new Error(`a tree of more than ${limits.nodes} nodes`)
    if (depth > limits.depth) throw new Error(`a tree deeper than ${limits.depth}`)
    const n = node as { type?: unknown; props?: unknown; children?: unknown; held?: unknown }
    if (typeof n.type !== 'string' || !ELEMENTS.has(n.type)) return null
    const props = n.props && typeof n.props === 'object' && !Array.isArray(n.props) ? (n.props as Record<string, unknown>) : undefined
    const children = Array.isArray(n.children) ? n.children.map(c => walk(c, depth + 1)).filter((c): c is WireNode => c !== null) : undefined
    return {
      type: n.type,
      ...(props && { props }),
      ...(children && { children }),
      ...(typeof n.held === 'number' && { press: { plugin, handle: n.held } }),
    }
  }
  return walk(JSON.parse(text), 0) ?? ''
}

const KEYS: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'return',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Home: 'home',
  End: 'end',
  ' ': 'space',
}

/** A Mod's `Client`: its surface module, run in the Mod's sandboxed frame, drawing into this region. */
export function ModClient({
  node,
  t,
}: {
  node: { props?: Record<string, unknown>; client?: { plugin: string } }
  t: T
}): ReactNode {
  const site = useContext(ModClientSite)
  const p = node.props ?? {}
  const plugin = node.client?.plugin ?? ''
  const key = typeof p.key === 'string' ? p.key : ''
  const module = typeof p.module === 'string' ? p.module : ''
  const propsText = JSON.stringify(p.props ?? null)
  const hash = site?.hashes?.[plugin]
  const box = useRef<HTMLDivElement>(null)
  const grid = useGrid(box, typeof p.height === 'number' ? p.height : undefined)
  const [tree, setTree] = useState<WireNode>()
  const [fault, setFault] = useState<{ reason: string; props: string }>()
  const live = useRef<{ frame: ModFrame; id: number } | undefined>(undefined)
  const posts = useRef<number[]>([])
  const ready = !!grid
  const halted = fault !== undefined && fault.props === propsText
  const address = site && { plugin, component: site.component, instance_id: site.instanceId, client: key, module }

  useEffect(() => {
    if (!site || !address || !ready || halted || !plugin || !module) return
    const frame = frameFor(site.request, plugin, hash)
    let id = 0
    id = frame.mount(
      {
        tree: text => {
          try {
            setTree(clientTree(text, plugin, frame.limits))
          } catch (err) {
            frame.unmount(id)
            report('render', err instanceof Error ? err.message : String(err))
          }
        },
        post: text => {
          const now = Date.now()
          posts.current = posts.current.filter(at => now - at < 1000)
          if (posts.current.length >= 20) return
          posts.current.push(now)
          void site
            .request({ subtype: 'ui_message', ...address, data: JSON.parse(text) })
            .then(res => {
              if (res.props !== undefined && live.current?.id === id) frame.send({ op: 'props', id, props: res.props })
            })
            .catch(() => {})
        },
        fault: (phase, reason) => report(phase, reason),
      },
      { module, props: JSON.parse(propsText), columns: grid.columns, rows: grid.rows },
    )
    live.current = { frame, id }
    const report = (phase: string, reason: string) => {
      if (live.current?.id !== id) return
      live.current = undefined
      setTree(undefined)
      setFault({ reason, props: propsText })
      void site.request({ subtype: 'ui_client_fault', ...address, phase, reason }).catch(() => {})
    }
    return () => {
      if (live.current?.id === id) live.current = undefined
      frame.unmount(id)
    }
    // Props and size reach a running instance below; these start a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site?.request, site?.component, site?.instanceId, plugin, key, module, hash, ready, halted])

  const first = useRef(true)
  useEffect(() => {
    if (first.current) return void (first.current = false)
    if (live.current) live.current.frame.send({ op: 'props', id: live.current.id, props: JSON.parse(propsText) })
    if (fault && fault.props !== propsText) setFault(undefined)
  }, [propsText, fault])
  useEffect(() => {
    if (grid && live.current) live.current.frame.send({ op: 'resize', id: live.current.id, columns: grid.columns, rows: grid.rows })
  }, [grid])

  if (!site || !address) return <span className="mod-note">{t('modClientView')}</span>
  const act = (body: Record<string, unknown>) => {
    const current = live.current
    if (!current) return
    const event =
      body.subtype === 'ui_press'
        ? { type: 'press' }
        : body.subtype === 'ui_input'
          ? { type: 'input', kind: body.kind, value: body.value }
          : { type: 'select', value: body.value }
    void site
      .request({ subtype: 'ui_client_press', ...address, element: String(body.key ?? ''), event })
      .then(res => {
        if (res.reached && live.current === current) current.frame.send({ op: 'held', id: current.id, handle: body.handle, event: res.reached })
      })
      .catch(() => {})
  }
  const cell = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const cols = grid?.columns || 1
    const rows = grid?.rows || 1
    return { x: Math.floor(((e.clientX - r.left) / r.width) * cols), y: Math.floor(((e.clientY - r.top) / r.height) * rows) }
  }
  const pointer = (type: string, e: PointerEvent<HTMLDivElement>) => {
    if (!live.current || (e.target as Element).closest('button, input, a')) return
    if (type === 'move' && !e.buttons) return
    const button = e.button === 1 ? 'middle' : e.button === 2 ? 'right' : 'left'
    const mods = { ...(e.shiftKey && { shift: true }), ...(e.altKey && { alt: true }), ...(e.ctrlKey && { ctrl: true }) }
    live.current.frame.send({ op: 'pointer', id: live.current.id, event: { type, ...cell(e), ...(type !== 'move' || e.buttons ? { button } : {}), ...mods } })
  }
  return (
    <div
      ref={box}
      className="mod-client"
      tabIndex={0}
      style={{ ...modStyle('Box', { width: p.width, height: p.height, flexGrow: p.flexGrow, flexDirection: 'column' }) }}
      onKeyDown={e => {
        if (!live.current || (e.target as Element) !== e.currentTarget) return
        if (e.key === 'Escape') return void e.currentTarget.blur()
        const name = KEYS[e.key] ?? (e.key.length === 1 ? e.key : undefined)
        if (!name) return
        e.preventDefault()
        const mods = { ...(e.ctrlKey && { ctrl: true }), ...(e.shiftKey && { shift: true }), ...(e.metaKey && { meta: true }) }
        live.current.frame.send({ op: 'key', id: live.current.id, event: { key: name, ...mods } })
      }}
      onPointerDown={e => pointer('down', e)}
      onPointerMove={e => pointer('move', e)}
      onPointerUp={e => pointer('up', e)}
    >
      {fault ? (
        <span className="mod-note">{t('modClientFault', { reason: fault.reason })}</span>
      ) : tree ? (
        <ModNode node={tree} act={act} t={t} />
      ) : (
        <span className="mod-note">{t('loading')}</span>
      )}
    </div>
  )
}
