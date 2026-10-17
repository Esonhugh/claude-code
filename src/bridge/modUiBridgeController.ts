import type { ModsSession } from '../services/mods/session.js'
import type { ModRenderSite } from '../services/mods/ui.js'
import type { ReplBridgeHandle } from './replBridge.js'
import { materializeModUiTree, type ModUiInboundEvent } from './modUiMessages.js'

type MountedSite = {
  surface: 'desktop' | 'mobile' | 'vscode'
  site: ModRenderSite
  abort: AbortController
}

export function createModUiBridgeController() {
  const sites = new Map<string, MountedSite>()
  const generations = new Map<string, object>()
  const pending = new Map<string, AbortController>()
  let session: ModsSession | undefined
  let sender: ReplBridgeHandle | undefined
  let disposed = false

  async function disposeSites(): Promise<void> {
    const mounted = [...sites.values()]
    sites.clear()
    generations.clear()
    for (const controller of pending.values())
      controller.abort(new Error('Remote Mod UI client detached'))
    pending.clear()
    for (const current of mounted) {
      await current.site.dispose().catch(() => {})
      current.abort.abort(new Error('Remote Mod UI client detached'))
    }
  }

  return {
    setSession(next: ModsSession | undefined): void {
      if (session === next) return
      session = next
      void disposeSites()
    },
    setSender(next: ReplBridgeHandle | undefined): void {
      if (sender === next) return
      const replaced = sender !== undefined
      sender = next
      if (replaced) void disposeSites()
    },
    async handle(event: ModUiInboundEvent): Promise<void> {
      if (disposed) return
      const existing = sites.get(event.client_id)
      if (event.subtype === 'detach') {
        const generation = generations.get(event.client_id)
        if (!existing) {
          if (generation !== undefined) generations.delete(event.client_id)
          pending.get(event.client_id)?.abort(new Error('Remote Mod UI client detached'))
          pending.delete(event.client_id)
          return
        }
        sites.delete(event.client_id)
        try {
          await existing.site.dispose()
        } finally {
          if (generations.get(event.client_id) === generation)
            generations.delete(event.client_id)
          existing.abort.abort(new Error('Remote Mod UI client detached'))
        }
        return
      }
      if (event.subtype === 'interact') {
        if (!existing) throw new Error('Remote Mod UI client is not attached')
        await existing.site.interact(event.drawing, event.callback, event.kind, event.element, event.value)
        return
      }
      if (event.subtype === 'update') {
        if (!existing) throw new Error('Remote Mod UI client is not attached')
        if (existing.surface !== event.surface) throw new Error('Remote Mod UI client surface cannot change')
        await existing.site.update(event.input)
        return
      }

      const generation = {}
      generations.set(event.client_id, generation)
      const replacedPending = pending.get(event.client_id)
      if (replacedPending) {
        replacedPending.abort(new Error('Remote Mod UI client replaced'))
        pending.delete(event.client_id)
      }
      if (existing) {
        sites.delete(event.client_id)
        try {
          await existing.site.dispose()
        } catch (error) {
          if (generations.get(event.client_id) === generation)
            generations.delete(event.client_id)
          throw error
        } finally {
          existing.abort.abort(new Error('Remote Mod UI client replaced'))
        }
        if (generations.get(event.client_id) !== generation) return
      }
      const runtime = session?.runtime
      if (!runtime) {
        if (generations.get(event.client_id) === generation)
          generations.delete(event.client_id)
        throw new Error('Mods runtime is unavailable')
      }
      const abort = new AbortController()
      pending.set(event.client_id, abort)
      let site: ModRenderSite
      try {
        site = await runtime.ui.mount(event.input, {
          surface: event.surface,
          clientId: event.client_id,
          signal: abort.signal,
          render(tree, drawing, resolveEngine) {
            if (generations.get(event.client_id) !== generation) return
            const target = sender
            if (!target) return
            target.sendModUiEvent({
              type: 'mod_ui', subtype: 'render', client_id: event.client_id, drawing,
              tree: materializeModUiTree(tree, resolveEngine),
            })
          },
          unmount() {
            if (generations.get(event.client_id) !== generation) return
            sender?.sendModUiEvent({ type: 'mod_ui', subtype: 'unmount', client_id: event.client_id })
          },
        })
      } catch (error) {
        if (pending.get(event.client_id) === abort)
          pending.delete(event.client_id)
        if (generations.get(event.client_id) === generation)
          generations.delete(event.client_id)
        abort.abort(error)
        throw error
      }
      if (pending.get(event.client_id) === abort)
        pending.delete(event.client_id)
      const mounted: MountedSite = { surface: event.surface, abort, site }
      if (disposed || abort.signal.aborted || generations.get(event.client_id) !== generation) {
        await site.dispose()
        return
      }
      sites.set(event.client_id, mounted)
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      sender = undefined
      await disposeSites()
      session = undefined
    },
  }
}

export type ModUiBridgeController = ReturnType<typeof createModUiBridgeController>
