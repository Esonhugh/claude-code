import { describe, expect, test } from 'bun:test'
import { createContext, SourceTextModule } from 'node:vm'
import { modStateLibrarySource } from './stateLibrary.js'

async function library() {
  const module = new SourceTextModule(modStateLibrarySource, {
    context: createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
    }),
  })
  await module.link(() => { throw new Error('unexpected import') })
  await module.evaluate()
  return module.namespace as any
}

const ref = { plugin: 'test', key: 'count' }

test('memberOf specializes atoms and references without changing the family', async () => {
  const { atom, memberOf } = await library()
  const family = atom({ ...ref, id: 'default' }, { count: 0 }, { shape: 2 })
  const member = memberOf(family, { requestId: 'request' })
  expect(member.ref).toEqual({ ...ref, id: 'request' })
  expect(member.initial).toBe(family.initial)
  expect(member.shape).toBe(2)
  expect(member[Symbol.for('claude-code.state.atom')]).toBe(true)
  expect(Object.isFrozen(member)).toBe(true)
  expect(Object.isFrozen(member.ref)).toBe(true)
  expect(family.ref.id).toBe('default')
  expect(memberOf(family, {}).ref.id).toBe('default')
  const plain = memberOf({ ...ref, extra: true }, { requestId: 'request' })
  expect(plain).toEqual({ ...ref, id: 'request' })
  expect(Object.isFrozen(plain)).toBe(true)
})

test('read resolves plain references, defaults, and shape envelopes', async () => {
  const { atom, read } = await library()
  let stored: unknown
  const $ = { state: { get: async (input: unknown) => {
    expect(input).toEqual(ref)
    return { value: stored, version: 0 }
  } } }
  const plain = atom(ref, 7)
  const shaped = atom(ref, 8, { shape: 'v2' })
  expect(await read($, ref)).toBeUndefined()
  expect(await read($, plain)).toBe(7)
  for (stored of [undefined, null, 0, { shape: 'v1', value: 1 }, { shape: 'v2' }]) {
    expect(await read($, shaped)).toBe(8)
  }
  for (stored of [null, false, 0]) expect(await read($, plain)).toBe(stored)
  for (const value of [null, false, 0, { nested: true }]) {
    stored = { shape: 'v2', value }
    expect(await read($, shaped)).toBe(value)
    expect(await read($, ref)).toBe(stored)
  }
})

test('derive flattens leaf versions and memoizes per derived object across reads', async () => {
  const { atom, derive, read } = await library()
  const leaf = atom(ref, 1)
  const raw = { plugin: 'test', key: 'other', extra: true }
  let calls = 0
  const inner = derive([leaf], (value: number) => value % 2)
  const sources = [inner, raw]
  const outer = derive(sources, (a: number, b: number) => { calls++; return { sum: a + b } })
  expect(Object.isFrozen(outer)).toBe(true)
  expect(Object.isFrozen(outer.sources)).toBe(true)
  expect(outer.sources[0]).toBe(inner)
  expect(outer.sources[1]).toEqual({ plugin: 'test', key: 'other' })
  expect(Object.isFrozen(outer.sources[1])).toBe(true)
  expect(outer[Symbol.for('claude-code.state.derived')]).toEqual({})
  sources.length = 0
  let version = 1
  let value = 1
  const $ = { state: { get: async (input: { key: string }) => ({
    value: input.key === 'count' ? value : 10,
    version: input.key === 'count' ? version : 2,
  }) } }
  const first = await read($, outer)
  expect(first).toEqual({ sum: 11 })
  expect(await read($, outer)).toBe(first)
  value = 3
  version++
  expect(await read($, outer)).not.toBe(first)
  expect(calls).toBe(2)
  const otherState = { state: { get: async () => ({ value: 100, version: 2 }) } }
  expect(await read(otherState, outer)).toEqual({ sum: 11 })
  expect(calls).toBe(2)
  let emptyCalls = 0
  const empty = derive([], () => ++emptyCalls)
  expect(await read($, empty)).toBe(1)
  expect(await read($, empty)).toBe(1)
})

test('update retries CAS with fresh values and writes shape envelopes', async () => {
  const { atom, update } = await library()
  const target = atom(ref, 10, { shape: 'v2' })
  const changes: number[] = []
  const writes: unknown[] = []
  let gets = 0
  const $ = { state: {
    get: async () => ({ value: ++gets === 1 ? { shape: 'v1', value: 99 } : { shape: 'v2', value: 20 }, version: gets }),
    set: async (...args: unknown[]) => { writes.push(args); return { isSet: gets === 2 } },
  } }
  expect(await update($, target, (current: number) => { changes.push(current); return current + 1 })).toBe(21)
  expect(changes).toEqual([10, 20])
  expect(writes).toEqual([
    [ref, { shape: 'v2', value: 11 }, { ifVersion: 1 }],
    [ref, { shape: 'v2', value: 21 }, { ifVersion: 2 }],
  ])
})

test('update permits the 64th CAS and stops after exactly 64 conflicts', async () => {
  const { update } = await library()
  for (const succeeds of [true, false]) {
    let gets = 0
    let sets = 0
    let changes = 0
    const $ = { state: {
      get: async () => ({ value: ++gets, version: gets }),
      set: async (input: unknown, value: number, options: unknown) => {
        expect(input).toBe(ref)
        expect(value).toBe(gets + 1)
        expect(options).toEqual({ ifVersion: gets })
        return { isSet: ++sets === 64 && succeeds }
      },
    } }
    const result = update($, ref, (value: number) => { changes++; return value + 1 })
    if (succeeds) expect(await result).toBe(65)
    else await expect(result).rejects.toThrow('update: the value was written by another every time it was read, up to the bound on tries; nothing was written')
    expect([gets, sets, changes]).toEqual([64, 64, 64])
  }
})

test('update invokes change synchronously without awaiting its result', async () => {
  const { atom, update } = await library()
  for (const target of [ref, atom(ref, 1), atom(ref, 1, { shape: 'v1' })]) {
    const next = Promise.resolve(42)
    const order: string[] = []
    const $ = { state: {
      get: async () => ({ value: undefined, version: 0 }),
      set: async (_ref: unknown, value: unknown) => {
        order.push('set')
        expect(target.shape ? (value as { value: unknown }).value : value).toBe(next)
        return { isSet: true }
      },
    } }
    expect(await update($, target, () => { order.push('change'); return next })).toBe(42)
    expect(order).toEqual(['change', 'set'])
  }
})

test('errors from state, compute, and change propagate without hidden retries', async () => {
  const { derive, read, update } = await library()
  const error = new Error('failure')
  let sets = 0
  const $ = { state: {
    get: async () => ({ value: 1, version: 1 }),
    set: async () => { sets++; throw error },
  } }
  await expect(update($, ref, () => { throw error })).rejects.toBe(error)
  expect(sets).toBe(0)
  await expect(update($, ref, (value: unknown) => value)).rejects.toBe(error)
  expect(sets).toBe(1)
  let computes = 0
  const derived = derive([ref], () => { if (++computes === 1) throw error; return 2 })
  await expect(read($, derived)).rejects.toBe(error)
  expect(await read($, derived)).toBe(2)
  expect(computes).toBe(2)
  const broken = { state: { get: async () => { throw error }, set: $.state.set } }
  await expect(read(broken, ref)).rejects.toBe(error)
  await expect(update(broken, ref, () => 2)).rejects.toBe(error)
  expect(sets).toBe(1)
})

test('module exports exactly five realm-local functions and shares brands across instances', async () => {
  const first = await library()
  const second = await library()
  expect(Object.keys(first).sort()).toEqual(['atom', 'derive', 'memberOf', 'read', 'update'])
  expect(Object.getPrototypeOf(first.atom)).not.toBe(Function.prototype)
  const external = first.atom(ref, 9)
  const $ = { state: { get: async () => ({ value: undefined, version: 0 }) } }
  expect(await second.read($, second.derive([external], (value: number) => value + 1))).toBe(10)
  expect(await second.read($, { ...external, [Symbol.for('claude-code.state.atom')]: false })).toBe(9)
  const nested = { mutable: true }
  first.atom(ref, Object.freeze({ nested }))
  expect(Object.isFrozen(nested)).toBe(false)
})

describe('Mods state library VM module', () => {
  test('atom freezes its initial tree and a normalized copy of its reference', async () => {
    const { atom } = await library()
    const initial = { nested: [{ count: 1 }] }
    const input = { ...ref, id: 'one', extra: true }
    const value = atom(input, initial, { shape: 'v1' })
    expect(value[Symbol.for('claude-code.state.atom')]).toBe(true)
    expect(value.ref).toEqual({ ...ref, id: 'one' })
    expect(value.ref).not.toBe(input)
    expect(value.initial).toBe(initial)
    expect(value.shape).toBe('v1')
    for (const part of [value, value.ref, initial, initial.nested, initial.nested[0]]) {
      expect(Object.isFrozen(part)).toBe(true)
    }
    expect(Object.isFrozen(input)).toBe(false)
    expect(atom(ref, 0)).not.toHaveProperty('shape')
  })
})
