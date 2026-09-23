import type { ModClientFrame, ModClientRequest } from './client.js'

export function copyModClientData(value: unknown, isProxy: (value: unknown) => boolean = () => false): unknown {
  let count = 0
  const path = new Set<object>()
  function copy(value: unknown, depth: number): unknown {
    if (++count > 20_000 || depth > 32) throw new RangeError('Client data exceeds its value/depth budget')
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (!value || typeof value !== 'object' || isProxy(value) || path.has(value)) throw new TypeError('Client data must be plain JSON')
    const proto = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new TypeError('Client data must be plain JSON')
    path.add(value)
    const keys = Object.keys(value)
    if (Array.isArray(value) && keys.length !== value.length) throw new TypeError('Client data arrays must be dense')
    const entries = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new TypeError('Client data accessors are unsupported')
      return [key, copy(descriptor.value, depth + 1)] as const
    })
    const result = Array.isArray(value) ? entries.map((entry, index) => {
      if (entry[0] !== String(index)) throw new TypeError('Client data arrays must be dense')
      return entry[1]
    }) : Object.fromEntries(entries)
    path.delete(value)
    return result
  }
  const result = copy(value, 1)
  if (JSON.stringify(result).length > 100_000) throw new RangeError('Client data exceeds 100000 characters')
  return result
}

// Runs inside the plugin VM; state and callbacks never cross the Worker boundary.
export function createModClientRealm(ui: {
  resolve(input: Record<string, unknown>): Readonly<Record<string, (props?: Record<string, unknown>) => unknown>>
  materialize(value: unknown, keep: (callback: (event: Record<string, unknown>) => unknown) => number): unknown
}, copyData: typeof copyModClientData = copyModClientData) {
  type Draw = (props: unknown, surface: any) => unknown
  type Instance = {
    id: number; draw: Draw; props: unknown; surface: object; state: unknown
    dirty: boolean; mounted: boolean; columns: number; rows: number; now: number
    timers: Set<{ ms: number; due: number; fn: () => void }>
    post?: unknown; loops: number; callbacks: Map<number, (event: Record<string, unknown>) => unknown>
    pointer?: (event: unknown) => void
    key?: (event: unknown) => void
  }
  const propsOf = (value: unknown): unknown => {
    if (value === undefined) return undefined
    const freeze = (value: unknown): unknown => {
      if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child)
        Object.freeze(value)
      }
      return value
    }
    return freeze(copyData(value))
  }
  let nextCallback = 0
  const modules = new Map<string, Draw>()
  const instances = new Map<number, Instance>()
  function dispose(id: number) {
    const instance = instances.get(id)
    if (!instance) return
    instance.mounted = false
    instances.delete(id)
    instance.state = undefined
    instance.timers.clear()
    instance.callbacks.clear()
    instance.post = undefined
    instance.pointer = instance.key = undefined
  }
  function render(instance: Instance): ModClientFrame {
    instance.dirty = false
    try {
      instance.callbacks.clear()
      const tree = ui.materialize(instance.draw(instance.props, instance.surface), callback => {
        const handle = ++nextCallback
        instance.callbacks.set(handle, callback)
        return handle
      })
      copyData(tree)
      const check = (node: any): void => {
        if (!node || typeof node !== 'object') return
        if (node.type === 'Client') throw new Error('A surface cannot draw a nested Client')
        for (const child of node.children ?? []) check(child)
      }
      check(tree)
      if (instance.dirty && ++instance.loops >= 3) throw new Error('Client render loop')
      if (!instance.dirty) instance.loops = 0
      return { tree, active: instance.dirty || instance.timers.size > 0 || instance.post !== undefined }
    } catch (error) { dispose(instance.id); throw error }
  }
  return {
    register(path: string, draw: Draw) { modules.set(path, draw) },
    request(input: ModClientRequest): ModClientFrame {
      try {
        if (input.op === 'dispose') { dispose(input.id); return {} }
        if (input.op === 'mount') {
          const draw = modules.get(input.module!)
          if (!draw) throw new Error('Client module is not in the loaded snapshot')
          dispose(input.id)
          const elements = { ...ui.resolve({ surface: 'terminal' }) }
          delete elements.Client
          const instance: Instance = { id: input.id, loops: 0, callbacks: new Map(), draw, props: propsOf(input.props), surface: {}, state: undefined, dirty: false, mounted: true, columns: 0, rows: 0, now: input.now ?? 0, timers: new Set() }
          instance.surface = Object.freeze({
            elements: Object.freeze(elements),
            get state() { return instance.state },
            get columns() { return instance.columns },
            get rows() { return instance.rows },
            post(data: unknown) {
              if (!instance.mounted) return
              try { instance.post = copyData(data) } catch { /* Invalid posts are not sent. */ }
            },
            every(ms: number, fn: () => void) {
              if (!Number.isFinite(ms) || ms < 0 || typeof fn !== 'function') throw new TypeError('Invalid Client timer')
              const timer = { ms, due: instance.now + ms, fn }
              if (instance.mounted) instance.timers.add(timer)
              return () => { instance.timers.delete(timer) }
            },
            onPointer(fn: (event: unknown) => void) {
              if (typeof fn !== 'function') throw new TypeError('Invalid Client pointer listener')
              if (instance.mounted) instance.pointer = fn
              return () => { if (instance.pointer === fn) instance.pointer = undefined }
            },
            onKey(fn: (event: unknown) => void) {
              if (typeof fn !== 'function') throw new TypeError('Invalid Client key listener')
              if (instance.mounted) instance.key = fn
              return () => { if (instance.key === fn) instance.key = undefined }
            },
            setState(next: unknown) {
              if (!instance.mounted) return
              instance.state = next
              instance.dirty = true
            },
          })
          instances.set(input.id, instance)
          return render(instance)
        }
        const instance = instances.get(input.id)
        if (!instance) return { stopped: true }
        if (input.op === 'update') { instance.loops = 0; instance.props = propsOf(input.props); return render(instance) }
        if (input.op === 'frame') {
          instance.now = input.now ?? instance.now
          for (const timer of [...instance.timers]) {
            if (!instance.timers.has(timer) || timer.due > instance.now) continue
            timer.due = instance.now + timer.ms
            instance.loops = 0
            timer.fn()
          }
          const frame = instance.dirty ? render(instance) : {}
          if (instance.post !== undefined) { frame.post = instance.post; instance.post = undefined }
          frame.active = instance.dirty || instance.timers.size > 0 || instance.post !== undefined
          return frame
        }
        if (input.op === 'pointer') { instance.loops = 0; instance.pointer?.(input.event); return { active: instance.dirty || instance.post !== undefined } }
        if (input.op === 'key') {
          instance.loops = 0
          if ((input.event as { key?: string })?.key !== 'escape') instance.key?.(input.event)
          return { active: instance.dirty || instance.post !== undefined }
        }
        if (input.op === 'press') {
          const callback = instance.callbacks.get(input.handle!)
          if (!callback) throw new Error('Client callback is stale')
          instance.loops = 0
          callback(input.event as Record<string, unknown>)
          return { active: instance.dirty || instance.post !== undefined }
        }
        if (input.op === 'resize') {
          if (instance.columns === input.columns && instance.rows === input.rows) return {}
          instance.columns = input.columns!; instance.rows = input.rows!
          return render(instance)
        }
        throw new Error('Unknown Client operation')
      } catch (error) { dispose(input.id); throw error }
    },
    dispose() { for (const id of instances.keys()) dispose(id); modules.clear() },
  }
}
