import { isDeepStrictEqual } from 'node:util'
import { isProxy } from 'node:util/types'
import { copyModClientData } from './clientRealm.js'
export { copyModClientData } from './clientRealm.js'
import type { ModUiCallback, ModUiInteraction, ModUiPane } from './ui.js'

export type ModClientRequest = {
  op: 'mount' | 'update' | 'frame' | 'pointer' | 'key' | 'press' | 'resize' | 'dispose'
  id: number
  element?: string
  module?: string
  props?: unknown
  now?: number
  event?: unknown
  columns?: number
  rows?: number
  handle?: number
}
export type ModClientFrame = { tree?: unknown; post?: unknown; stopped?: boolean; active?: boolean }
export type ModClientHandle = {
  ready: Promise<void>
  update(pane: ModUiPane, node: unknown): Promise<void>
  resize(columns: number, rows: number): Promise<void>
  pointer(event: unknown): Promise<void>
  key(event: unknown): Promise<void>
  press(callback: ModUiCallback, kind: ModUiInteraction, element: string, value?: string): Promise<unknown>
  dispose(): Promise<void>
}
export type ModClients = {
  mount(pane: ModUiPane, node: unknown, commit: (tree: unknown) => void, onError?: (error: unknown) => void): ModClientHandle
  reconcile(panes: readonly ModUiPane[]): void
}

type ClientNode = { type: 'Client'; props: { key: string; module: string; props?: unknown }; group: { plugin: string } }
export function findModClient(tree: unknown, plugin: string, key: string, module: string): boolean {
  if (!tree || typeof tree !== 'object') return false
  const node = tree as ClientNode & { children?: unknown[] }
  return node.type === 'Client' && node.group?.plugin === plugin && node.props?.key === key && node.props.module === module ||
    Array.isArray(node.children) && node.children.some(child => findModClient(child, plugin, key, module))
}

export function createModClients(options: {
  request(pane: ModUiPane, plugin: string, request: ModClientRequest): Promise<ModClientFrame>
  message(pane: ModUiPane, plugin: string, input: { element: string; module: string; data: unknown }): Promise<{ props?: unknown }>
  validate(tree: unknown): void
}): ModClients {
  let nextId = 0
  let currentPanes: readonly ModUiPane[] | undefined
  const mounted = new Set<{ pane: ModUiPane; node: ClientNode; dispose(): Promise<void> }>()
  return {
    reconcile(panes) {
      currentPanes = panes
      for (const entry of mounted) {
        const pane = panes.find(pane => pane.owner === entry.pane.owner && pane.id === entry.pane.id && pane.visible)
        if (!pane || !findModClient(pane.tree, entry.node.group.plugin, entry.node.props.key, entry.node.props.module))
          void entry.dispose()
      }
    },
    mount(pane, raw, commit, onError) {
      let node = raw as ClientNode
      if (currentPanes && !currentPanes.some(current => current.owner === pane.owner && current.id === pane.id &&
          current.visible && current.drawing === pane.drawing && findModClient(current.tree, node.group.plugin, node.props.key, node.props.module)))
        throw new Error('Client drawing is stale')
      if ([...mounted].some(entry => entry.pane.owner === pane.owner && entry.pane.id === pane.id &&
          entry.node.group.plugin === node.group.plugin && entry.node.props.key === node.props.key))
        throw new Error('Client key is already mounted in this drawing')
      const initialProps = node.props.props === undefined ? undefined : copyModClientData(node.props.props, isProxy)
      const id = ++nextId
      const plugin = node.group.plugin
      let disposed = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let queue = Promise.resolve()
      let generation = 0
      let lastTree: unknown
      let disposePromise: Promise<void> | undefined
      const entry = { pane, node, dispose: () => handle.dispose() }
      mounted.add(entry)
      const schedule = () => {
        if (disposed || timer !== undefined) return
        timer = setTimeout(() => {
          timer = undefined
          void run({ op: 'frame', id, now: performance.now() }).catch(fail)
        }, 16)
        timer.unref?.()
      }
      const fail = (error: unknown) => {
        if (disposed) return
        void handle.dispose()
        onError?.(error)
      }
      const deliver = (frame: ModClientFrame) => {
        if (disposed) return
        if (frame.stopped) { void handle.dispose(); return }
        if (frame.tree !== undefined) {
          options.validate(frame.tree)
          lastTree = frame.tree
          commit(frame.tree)
        }
        if (frame.active) schedule()
        if (Object.hasOwn(frame, 'post')) {
          const sent = ++generation
          void options.message(pane, plugin, { element: node.props.key, module: node.props.module, data: frame.post }).then(result => {
            if (disposed || sent !== generation || !Object.hasOwn(result, 'props')) return
            return run({ op: 'update', id, props: copyModClientData(result.props, isProxy) }, () => sent === generation)
          }).catch(error => { if (sent === generation) fail(error) })
        }
      }
      const run = (request: ModClientRequest, stillCurrent: () => boolean = () => true): Promise<void> => {
        const operation = queue.then(async () => {
          if (disposed || !stillCurrent()) return
          deliver(await options.request(pane, plugin, request))
        })
        queue = operation.catch(() => {})
        void operation.catch(fail)
        return operation
      }
      const props = (value: unknown) => value === undefined ? undefined : copyModClientData(value, isProxy)
      const ready = run({ op: 'mount', id, element: node.props.key, module: node.props.module, props: initialProps, now: performance.now() })
      const handle: ModClientHandle = {
        ready,
        async update(nextPane, raw) {
          if (disposed) return
          const next = raw as ClientNode
          if (nextPane.owner !== pane.owner || nextPane.id !== pane.id || next.group.plugin !== plugin ||
              next.props.key !== node.props.key || next.props.module !== node.props.module)
            throw new Error('Client instance identity cannot change')
          const changed = !isDeepStrictEqual(node.props.props, next.props.props) || pane.drawing !== nextPane.drawing
          pane = nextPane; node = next; entry.pane = pane; entry.node = node
          if (changed) { generation++; await run({ op: 'update', id, props: props(node.props.props) }) }
        },
        async resize(columns, rows) {
          if (!Number.isInteger(columns) || columns < 0 || !Number.isInteger(rows) || rows < 0) throw new TypeError('Invalid Client region')
          await run({ op: 'resize', id, columns, rows })
        },
        async pointer(event) { await run({ op: 'pointer', id, event: copyModClientData(event, isProxy) }) },
        async key(event) { await run({ op: 'key', id, event: copyModClientData(event, isProxy) }) },
        async press(callback, kind, element, value) {
          if (disposed) throw new Error('Client callback is stale')
          const contains = (tree: any): boolean => tree && typeof tree === 'object' && (
            tree.props?.key === element && tree.press?.plugin === plugin && tree.press?.handle === callback.handle ||
            Array.isArray(tree.children) && tree.children.some(contains))
          if (callback.plugin !== plugin || !contains(lastTree)) throw new Error('Client callback is stale')
          await run({ op: 'press', id, handle: callback.handle, event: {
            plugin, surface: 'terminal', component: 'Pane', requestId: pane.id,
            element, ...(value === undefined ? {} : { value }),
            ...(kind === 'input.change' ? { kind: 'change' } : kind === 'input.submit' ? { kind: 'submit' } : {}),
          } }, () => contains(lastTree))
        },
        dispose() {
          if (disposePromise) return disposePromise
          disposed = true
          generation++
          if (timer !== undefined) clearTimeout(timer)
          mounted.delete(entry)
          lastTree = undefined
          disposePromise = queue.then(() => options.request(pane, plugin, { op: 'dispose', id })).then(() => {}, error => { onError?.(error) })
          return disposePromise
        },
      }
      void ready.catch(fail)
      return handle
    },
  }
}
