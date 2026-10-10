export type ModToolNotice = {plugin: string; text: string}

/** Shared by snapshots; a notice may arrive before its permission dialog mounts. */
export function createModToolNotices() {
  const open = new Map<string, {plugin?: string}>()
  const notices = new Map<string, ModToolNotice>()
  const listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    read: (id: string) => notices.get(id),
    open(id: string, plugin?: string) {
      const call = {plugin}
      open.set(id, call)
      return () => {
        if (open.get(id) !== call) return
        open.delete(id)
        if (notices.delete(id)) emit()
      }
    },
    set(id: string, plugin: string, text: string | undefined): string | undefined {
      if (!open.has(id)) return 'no call with that tool_use_id is open'
      const owner = open.get(id)!.plugin
      if (owner !== undefined && owner !== plugin) return "the call is another plugin's $.tool.call run"
      const previous = notices.get(id)
      if (text === undefined) { if (notices.delete(id)) emit(); return }
      if (previous?.plugin === plugin && previous.text === text) return
      notices.set(id, {plugin, text})
      emit()
    },
  }
}
export type ModToolNotices = ReturnType<typeof createModToolNotices>
