import { AsyncLocalStorage } from 'node:async_hooks'
import type { ModStateReference } from './types.js'

export type ModStateGetResult = { value: unknown; version: number }
export type ModStateSetInput = ModStateReference & {
  value: unknown
  ifVersion?: number
}
export type ModStateSetResult = { isSet: boolean; version: number }

type Entry = { value: unknown; version: number }
type Scope = {
  generation: number
  values: Map<string, Entry>
  render?: { instance: string; reads: Map<string, number> }
}

const maxJsonCharacters = 4_194_304
const referenceKeys = new Set(['plugin', 'key', 'id'])
const setKeys = new Set(['plugin', 'key', 'id', 'value', 'ifVersion', 'previous'])

function referenceProblem(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'state reference must be an object { plugin, key, id? }'
  const ref = value as Record<string, unknown>
  if (typeof ref.plugin !== 'string' || !ref.plugin || typeof ref.key !== 'string' || !ref.key ||
      ref.id !== undefined && typeof ref.id !== 'string')
    return 'state reference must have non-empty string plugin and key, and optional string id'
  if ([ref.plugin, ref.key, ref.id].some(part => typeof part === 'string' && part.includes('\0')))
    return 'state reference plugin, key, and id must not contain NUL'
  const extra = Object.keys(ref).find(key => !allowed.has(key))
  return extra === undefined ? undefined : `state input has unexpected field ${extra}`
}

function validateReference(value: unknown, allowed = referenceKeys): asserts value is ModStateReference {
  const problem = referenceProblem(value, allowed)
  if (problem) throw new TypeError(problem)
}

function keyOf(ref: ModStateReference): string {
  return ref.id === undefined
    ? `${ref.plugin}\0${ref.key}`
    : `${ref.plugin}\0${ref.key}\0${ref.id}`
}

export function normalizeModStateValue(value: unknown): unknown {
  let text: string | undefined
  try { text = JSON.stringify(value) }
  catch (error) {
    throw new TypeError(`state.set value is not JSON data (${error instanceof Error ? error.message : String(error)})`)
  }
  if (text === undefined) throw new TypeError('state.set value is not JSON data')
  if (text.length > maxJsonCharacters)
    throw new RangeError(`state.set value is ${text.length} characters, over the ${maxJsonCharacters} limit`)
  return deepFreeze(JSON.parse(text))
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value)
}

export function createModState({
  onStale = () => {},
}: {
  onStale?: (instances: readonly string[]) => void
} = {}) {
  let values = new Map<string, Entry>()
  let versionFloor = 0
  let generation = 0
  const scopes = new AsyncLocalStorage<Scope>()
  const renderGenerations = new Map<string, object>()
  const readsByInstance = new Map<string, Set<string>>()
  const instancesByKey = new Map<string, Set<string>>()

  function notifyWrite(key: string): void {
    const instances = instancesByKey.get(key)
    if (instances?.size) onStale(Object.freeze([...instances]))
  }

  function forgetRender(instance: string): void {
    renderGenerations.delete(instance)
    const reads = readsByInstance.get(instance)
    if (!reads) return
    readsByInstance.delete(instance)
    for (const key of reads) {
      const instances = instancesByKey.get(key)
      instances?.delete(instance)
      if (instances?.size === 0) instancesByKey.delete(key)
    }
  }

  function commitRender(instance: string, reads: ReadonlyMap<string, number>): void {
    forgetRender(instance)
    if (reads.size === 0) return
    const keys = new Set(reads.keys())
    readsByInstance.set(instance, keys)
    let stale = false
    for (const [key, version] of reads) {
      const instances = instancesByKey.get(key) ?? new Set<string>()
      instances.add(instance)
      instancesByKey.set(key, instances)
      stale ||= (values.get(key)?.version ?? 0) !== version
    }
    if (stale) onStale(Object.freeze([instance]))
  }

  return {
    async get(ref: ModStateReference): Promise<ModStateGetResult> {
      validateReference(ref)
      const key = keyOf(ref)
      const scope = scopes.getStore()
      const entry = (scope?.values ?? values).get(key)
      const version = entry?.version ?? 0
      if (scope?.render && !scope.render.reads.has(key)) scope.render.reads.set(key, version)
      return Object.freeze({ value: entry?.value, version })
    },

    async set(owner: string, input: ModStateSetInput): Promise<ModStateSetResult> {
      validateReference(input, setKeys)
      if (input.plugin !== owner)
        throw new Error(`state.set denied: ${input.plugin} owns that value and only its owner writes it`)
      if (input.ifVersion !== undefined && (!Number.isSafeInteger(input.ifVersion) || input.ifVersion < 0))
        throw new TypeError('state.set ifVersion must be a non-negative safe integer')
      const scope = scopes.getStore()
      if (scope?.render)
        throw new Error('state.set denied: ui.render is pure and cannot write state')
      if (scope && scope.generation !== generation)
        throw new Error('state.set denied: session state was reset during this dispatch')
      const normalized = normalizeModStateValue(input.value)
      const key = keyOf(input)
      const entry = values.get(key)
      const current = entry?.version ?? 0
      if (input.ifVersion !== undefined && input.ifVersion !== current) {
        if (scope) {
          scope.values = new Map(scope.values)
          if (entry) scope.values.set(key, entry)
          else scope.values.delete(key)
        }
        return Object.freeze({ isSet: false, version: current })
      }
      const version = Math.max(current, versionFloor) + 1
      values = new Map(values).set(key, { value: normalized, version })
      if (scope) scope.values = new Map(scope.values).set(key, { value: normalized, version })
      notifyWrite(key)
      return Object.freeze({ isSet: true, version })
    },

    dispatch<T>(callback: () => T): T {
      return scopes.getStore() ? callback() : scopes.run({ generation, values }, callback)
    },

    async render<T>(instance: string, callback: () => T | Promise<T>): Promise<T> {
      const render = { instance, reads: new Map<string, number>() }
      renderGenerations.set(instance, render)
      try { return await scopes.run({ generation, values, render }, callback) }
      finally {
        if (renderGenerations.get(instance) === render) commitRender(instance, render.reads)
      }
    },

    forgetRender,

    previous(input: ModStateReference): unknown {
      validateReference(input)
      return values.get(keyOf(input))?.value
    },

    reset(): void {
      generation++
      for (const entry of values.values()) versionFloor = Math.max(versionFloor, entry.version)
      values = new Map()
      const stale = [...readsByInstance.keys()]
      renderGenerations.clear()
      readsByInstance.clear()
      instancesByKey.clear()
      if (stale.length) onStale(Object.freeze(stale))
    },
  }
}

export type ModState = ReturnType<typeof createModState>
