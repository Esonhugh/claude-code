import { isDeepStrictEqual } from 'node:util'
import { isProxy } from 'node:util/types'
import { copyModClientData } from './clientRealm.js'
export { copyModClientData } from './clientRealm.js'
import type { ModUiCallback, ModUiInteraction, ModRenderSurface, ModRenderComponent } from './ui.js'

export type ModClientSite = {
  owner: object
  id: string
  visible: boolean
  tree?: unknown
  drawing?: number
  surface?: ModRenderSurface
  component?: ModRenderComponent
  clock?: 'manual'
}

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
export type ModClientFrame = { tree?: unknown; post?: unknown; stopped?: boolean; active?: boolean; nextDue?: number }
export type ModClientHandle = {
  ready: Promise<void>
  update(pane: ModClientSite, node: unknown): Promise<void>
  resize(columns: number, rows: number): Promise<void>
  pointer(event: unknown): Promise<void>
  key(event: unknown): Promise<void>
  press(callback: ModUiCallback, kind: ModUiInteraction, element: string, value?: string): Promise<unknown>
  post(data: unknown): Promise<void>
  advance(ms: number): Promise<void>
  settled?(): Promise<void>
  dispose(): Promise<void>
}
export type ModClients = {
  mount(pane: ModClientSite, node: unknown, commit: (tree: unknown) => void, onError?: (error: unknown) => void): ModClientHandle
  reconcile(panes: readonly ModClientSite[]): void
}

type ClientNode = { type: 'Client'; props: { key: string; module: string; props?: unknown }; group: { plugin: string } }
export function findModClient(tree: unknown, plugin: string, key: string, module: string): boolean {
  if (!tree || typeof tree !== 'object') return false
  const node = tree as ClientNode & { children?: unknown[] }
  return node.type === 'Client' && node.group?.plugin === plugin && node.props?.key === key && node.props.module === module ||
    Array.isArray(node.children) && node.children.some(child => findModClient(child, plugin, key, module))
}

export function createModClients(options: {
  request(pane: ModClientSite, plugin: string, request: ModClientRequest): Promise<ModClientFrame>
  message(pane: ModClientSite, plugin: string, input: { element: string; module: string; data: unknown }): Promise<{ props?: unknown }>
  validate(tree: unknown): void
}): ModClients {
  let nextId = 0
  let currentPanes: readonly ModClientSite[] | undefined
  const mounted = new Set<{ pane: ModClientSite; node: ClientNode; dispose(): Promise<void> }>()
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
      let now = pane.clock === 'manual' ? 0 : performance.now()
      let nextDue: number | undefined
      let needsFrame = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let queue = Promise.resolve()
      let scheduledFrame: Promise<void> | undefined
      let finishFrame: (() => void) | undefined
      const posts = new Set<Promise<void>>()
      let generation = 0
      let lastTree: unknown
      let disposePromise: Promise<void> | undefined
      const stopped = Promise.withResolvers<void>()
      const entry = { pane, node, dispose: () => handle.dispose() }
      mounted.add(entry)
      const schedule = () => {
        if (disposed || pane.clock === 'manual' || timer !== undefined) return
        scheduledFrame = new Promise<void>(resolve => { finishFrame = resolve })
        timer = setTimeout(() => {
          timer = undefined
          const finish = finishFrame!
          scheduledFrame = undefined
          finishFrame = undefined
          void run({ op: 'frame', id, now: performance.now() }).catch(fail).finally(finish)
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
        nextDue = frame.nextDue
        needsFrame = frame.active === true
        if (frame.stopped) { void handle.dispose(); return }
        if (frame.tree !== undefined) {
          options.validate(frame.tree)
          lastTree = frame.tree
          commit(frame.tree)
        }
        if (frame.active) schedule()
        if (Object.hasOwn(frame, 'post')) void post(frame.post).catch(() => {})
      }
      const post = (data: unknown): Promise<void> => {
        if (disposed) return Promise.reject(new Error('Client instance is stale'))
        const sent = ++generation
        const work = options.message(pane, plugin, { element: node.props.key, module: node.props.module, data }).then(result => {
          if (disposed || sent !== generation || !Object.hasOwn(result, 'props')) return
          return run({ op: 'update', id, props: copyModClientData(result.props, isProxy) }, () => sent === generation)
        }).catch(error => { if (!disposed && sent === generation) { fail(error); throw error } })
        posts.add(work)
        void work.then(() => posts.delete(work), () => posts.delete(work))
        return Promise.race([work, stopped.promise])
      }
      const run = (request: ModClientRequest, stillCurrent: () => boolean = () => true): Promise<void> => {
        const operation = queue.then(async () => {
          if (disposed || !stillCurrent()) return
          const frame = await options.request(pane, plugin, request)
          if (stillCurrent()) deliver(frame)
        })
        queue = operation.catch(() => {})
        void operation.catch(fail)
        return operation
      }
      const props = (value: unknown) => value === undefined ? undefined : copyModClientData(value, isProxy)
      const ready = run({ op: 'mount', id, element: node.props.key, module: node.props.module, props: initialProps, now })
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
            plugin, surface: pane.surface ?? 'terminal', component: pane.component ?? 'Pane', requestId: pane.id,
            element, ...(value === undefined ? {} : { value }),
            ...(kind === 'input.change' ? { kind: 'change' } : kind === 'input.submit' ? { kind: 'submit' } : {}),
          } }, () => contains(lastTree))
        },
        async post(data) {
          await post(copyModClientData(data, isProxy))
          await handle.settled?.()
        },
        async advance(ms) {
          if (disposed) throw new Error('Client instance is stale')
          if (pane.clock !== 'manual') throw new Error('Client advance requires a manual clock')
          if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(now + ms)) throw new TypeError('Invalid Client advance')
          await queue
          const end = now + ms
          while (!disposed && nextDue !== undefined && nextDue <= end) {
            now = Math.max(now, nextDue)
            await run({ op: 'frame', id, now })
            await Promise.race([Promise.all([...posts]), stopped.promise])
          }
          now = end
          if (!disposed) await run({ op: 'frame', id, now })
          await handle.settled?.()
        },
        async settled() {
          // Observe one already scheduled frame and its replies, never drain recurring clocks.
          await queue
          if (pane.clock === 'manual' && needsFrame) await run({ op: 'frame', id, now })
          const frame = scheduledFrame
          if (frame) await frame
          await Promise.race([Promise.all([...posts]), stopped.promise])
          await queue
        },
        dispose() {
          if (disposePromise) return disposePromise
          disposed = true
          stopped.resolve()
          generation++
          if (timer !== undefined) clearTimeout(timer)
          finishFrame?.()
          scheduledFrame = undefined
          finishFrame = undefined
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
