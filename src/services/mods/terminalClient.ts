import { isProxy } from 'node:util/types'
import { copyModClientData, findModClient, modClientReason } from './client.js'
import type { ModClientHandle, ModClients, ModClientSite } from './client.js'

export type ModTerminalSize = {
  columns: number
  rows: number
  conversationColumns: number
}
export type ModTerminalClientSnapshot =
  | { status: 'loading' }
  | { status: 'drawn'; tree: unknown }
  | { status: 'failed'; text: string }
export type ModTerminalClientHandle = ModClientHandle & {
  subscribe(listener: () => void): () => void
  getSnapshot(): ModTerminalClientSnapshot
  threw(error: unknown): void
  drawnAgain(): void
  retain(size: () => ModTerminalSize): ModTerminalClientHandle
}
type Node = {
  type: 'Client'
  group: { plugin: string }
  props: { key: string; module: string; props?: unknown }
}

// These leases belong to the terminal consumer. Ordinary mount admission remains
// strict, and every retry obtains a fresh numeric Worker instance underneath.
export function withTerminalClients(clients: ModClients): ModClients {
  const owners = new Map<object, Map<string, Entry>>()
  type Entry = {
    identity: string
    pane: ModClientSite
    node: Node
    holders: number
    dead: boolean
    epoch: number
    inner?: ModClientHandle
    needsMount?: boolean
    disposal?: Promise<void>
    released: Set<() => void>
    pending: Promise<void>
    handedProps: unknown
    renderedAt: string
    thrownAt?: string
    region?: [number, number]
    snapshot: ModTerminalClientSnapshot
    listeners: Set<() => void>
    commits: Map<object, (tree: unknown) => void>
    sizes: Map<object, () => ModTerminalSize>
    destruction?: ReturnType<typeof setTimeout>
    destroy(): Promise<void>
    restart(): void
  }
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, entry: unknown) =>
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, (entry as Record<string, unknown>)[key]]),
          )
        : entry,
    )
  const propsCopy = (value: unknown) =>
    value === undefined ? undefined : copyModClientData(value, isProxy)
  const layout = (entry: Entry): string => {
    const get = [...entry.sizes.values()].at(-1)
    const size = get?.() ?? { columns: 0, rows: 0, conversationColumns: 0 }
    return `${size.columns}x${size.rows}x${size.conversationColumns}`
  }
  const fingerprint = (entry: Entry, size = layout(entry)) =>
    `${size} ${stable({ props: entry.handedProps })}`
  const publish = (entry: Entry, snapshot: ModTerminalClientSnapshot) => {
    entry.snapshot = snapshot
    for (const listener of entry.listeners) listener()
  }
  const identity = (pane: ModClientSite, node: Node) =>
    `${pane.surface ?? 'terminal'}\0${pane.component ?? 'Pane'}\0${pane.id}\0${node.group.plugin}\0${node.props.key}`
  const acquire: NonNullable<ModClients['acquire']> = (
    pane,
    raw,
    commit,
    size,
  ) => {
    const node = raw as Node
    const id = identity(pane, node)
    let registry = owners.get(pane.owner)
    if (!registry) owners.set(pane.owner, (registry = new Map()))
    let entry = registry.get(id)
    if (entry && entry.node.props.module !== node.props.module) {
      void entry.destroy()
      entry = undefined
      registry = owners.get(pane.owner)
      if (!registry) owners.set(pane.owner, (registry = new Map()))
    }
    if (!entry) {
      const created: Entry = {
        identity: id,
        pane,
        node,
        holders: 0,
        dead: false,
        epoch: 0,
        pending: Promise.resolve(),
        handedProps: propsCopy(node.props.props),
        renderedAt: '',
        snapshot: { status: 'loading' },
        released: new Set(),
        listeners: new Set(),
        commits: new Map(),
        sizes: new Map(),
        destroy() {
          if (created.dead) return created.disposal ?? Promise.resolve()
          created.dead = true
          created.epoch++
          if (created.destruction !== undefined)
            clearTimeout(created.destruction)
          created.disposal =
            created.inner?.dispose().catch(() => {}) ?? Promise.resolve()
          created.inner = undefined
          created.thrownAt = undefined
          created.listeners.clear()
          created.commits.clear()
          created.sizes.clear()
          const current = owners.get(pane.owner)
          if (current?.get(id) === created) current.delete(id)
          if (current && !current.size) owners.delete(pane.owner)
          return created.disposal.finally(() => {
            for (const release of created.released) release()
            created.released.clear()
          })
        },
        restart() {
          if (created.dead || created.holders === 0) return
          created.needsMount = false
          const epoch = ++created.epoch
          void created.inner?.dispose().catch(() => {})
          created.inner = undefined
          created.thrownAt = undefined
          created.node = {
            ...created.node,
            props: { ...created.node.props, props: created.handedProps },
          }
          publish(created, { status: 'loading' })
          let renderingAt = layout(created)
          const failed = (error: unknown) => {
            if (created.dead || epoch !== created.epoch) return
            created.inner = undefined
            const reason = modClientReason(
              error,
              created.node.group.plugin,
              created.node.props.module,
            )
            publish(created, {
              status: 'failed',
              text: `${created.node.group.plugin}: Client ${created.node.props.module}: ${reason}`,
            })
          }
          try {
            const inner = clients.mount(
              created.pane,
              created.node,
              (tree) => {
                if (created.dead || epoch !== created.epoch) return
                created.renderedAt = renderingAt
                publish(created, { status: 'drawn', tree })
                for (const update of created.commits.values()) update(tree)
              },
              failed,
              () => {
                renderingAt = layout(created)
              },
            )
            created.inner = inner
            created.pending = inner.ready
              .then(async () => {
                if (
                  created.dead ||
                  epoch !== created.epoch ||
                  created.inner !== inner
                )
                  return
                if (created.region) await inner.resize(...created.region)
              })
              .catch(() => {})
          } catch (error) {
            failed(error)
          }
        },
      }
      entry = created
      registry.set(id, entry)
    }
    const held = entry
    const lease = (
      getSize: () => ModTerminalSize,
      onTree?: (tree: unknown) => void,
    ): ModTerminalClientHandle => {
      if (held.dead) throw new Error('Client instance is stale')
      if (held.destruction !== undefined) {
        clearTimeout(held.destruction)
        held.destruction = undefined
        for (const release of held.released) release()
        held.released.clear()
      }
      const token = {}
      held.holders++
      held.sizes.set(token, getSize)
      if (onTree) held.commits.set(token, onTree)
      let released = false
      const live = () => {
        if (released || held.dead) throw new Error('Client instance is stale')
        return held.inner
      }
      const handle: ModTerminalClientHandle = {
        get ready() {
          return held.pending
        },
        subscribe(listener) {
          held.listeners.add(listener)
          return () => {
            held.listeners.delete(listener)
          }
        },
        getSnapshot: () => held.snapshot,
        threw(error) {
          if (released || held.dead) return
          const inner = held.inner
          if (!inner || held.snapshot.status !== 'drawn') return
          const at = fingerprint(held, held.renderedAt)
          inner.threw?.(error)
          // Only a true terminal boundary throw grants retry admission.
          held.thrownAt = at
        },
        drawnAgain() {
          if (released || held.dead) return
          if (
            held.thrownAt !== undefined &&
            held.thrownAt !== fingerprint(held) &&
            held.holders > 0
          )
            held.restart()
        },
        retain: (get) => {
          live()
          return lease(get)
        },
        async update(nextPane, rawNode) {
          const inner = live()
          const next = rawNode as Node
          if (
            nextPane.owner !== held.pane.owner ||
            identity(nextPane, next) !== held.identity ||
            next.props.module !== held.node.props.module
          )
            throw new Error('Client instance identity cannot change')
          held.handedProps = propsCopy(next.props.props)
          held.pane = nextPane
          held.node = next
          if (held.needsMount) {
            held.restart()
            await held.pending
          } else await inner?.update(nextPane, next)
        },
        async resize(columns, rows) {
          const inner = live()
          if (
            !Number.isInteger(columns) ||
            columns < 0 ||
            !Number.isInteger(rows) ||
            rows < 0
          )
            throw new TypeError('Invalid Client region')
          held.region = [columns, rows]
          await inner?.resize(columns, rows)
        },
        async pointer(event) {
          await live()?.pointer(event)
        },
        async key(event) {
          await live()?.key(event)
        },
        async press(...args) {
          const inner = live()
          if (!inner) throw new Error('Client callback is stale')
          return inner.press(...args)
        },
        async post(data) {
          await live()?.post(data)
        },
        async advance(ms) {
          const inner = live()
          if (!inner) throw new Error('Client instance is stale')
          await inner.advance(ms)
        },
        async settled() {
          live()
          await held.pending
          await held.inner?.settled?.()
        },
        async dispose() {
          if (released) return
          if (held.dead) {
            released = true
            await held.disposal
            return
          }
          released = true
          held.holders--
          held.sizes.delete(token)
          held.commits.delete(token)
          if (held.holders === 0 && !held.dead) {
            const completion = Promise.withResolvers<void>()
            held.released.add(completion.resolve)
            held.destruction = setTimeout(() => {
              if (held.holders === 0) void held.destroy()
            }, 0)
            await completion.promise
          }
        },
      }
      if (held.snapshot.status === 'drawn') onTree?.(held.snapshot.tree)
      return handle
    }
    const handle = lease(size, commit)
    held.pane = pane
    held.node = node
    held.handedProps = propsCopy(node.props.props)
    if (held.epoch === 0) held.restart()
    else held.pending = handle.update(pane, node).catch(() => {})
    return handle
  }
  return {
    ...clients,
    acquire,
    invalidatePlugin(plugin) {
      for (const registry of owners.values())
        for (const entry of registry.values()) {
          if (entry.node.group.plugin !== plugin || entry.dead) continue
          entry.epoch++
          entry.needsMount = true
          entry.thrownAt = undefined
          void entry.inner?.dispose().catch(() => {})
          entry.inner = undefined
          entry.pending = Promise.resolve()
          publish(entry, { status: 'loading' })
        }
    },
    reconcile(panes) {
      clients.reconcile(panes)
      for (const registry of owners.values())
        for (const entry of registry.values()) {
          if (
            !panes.some(
              (pane) =>
                pane.owner === entry.pane.owner &&
                identity(pane, entry.node) === entry.identity &&
                pane.visible &&
                findModClient(
                  pane.tree,
                  entry.node.group.plugin,
                  entry.node.props.key,
                  entry.node.props.module,
                ),
            )
          )
            entry.destroy()
        }
    },
  }
}
