import { describe, expect, test } from 'bun:test'
import { createModState } from './state.js'

const shared = { plugin: 'owner', key: 'shared' }

describe('Mods state', () => {
  test('normalizes JSON, versions writes, and applies optimistic conditions', async () => {
    const state = createModState()
    const value = { kept: true, missing: undefined, array: [undefined, Number.NaN] }

    expect(await state.get(shared)).toEqual({ value: undefined, version: 0 })
    expect(await state.set('owner', { ...shared, value })).toEqual({ isSet: true, version: 1 })
    expect(await state.get(shared)).toEqual({
      value: { kept: true, array: [null, null] },
      version: 1,
    })
    expect(await state.set('owner', { ...shared, value: 'lost', ifVersion: 0 })).toEqual({
      isSet: false,
      version: 1,
    })
    expect(await state.set('owner', { ...shared, value: 'next', ifVersion: 1 })).toEqual({
      isSet: true,
      version: 2,
    })
  })

  test('rejects invalid references, values over 4 Mi characters, foreign writes, and render writes', async () => {
    const state = createModState()
    await expect(state.get({ plugin: '', key: 'x' })).rejects.toThrow(/reference/)
    await expect(state.get({ plugin: 'owner', key: 'x\0y' })).rejects.toThrow(/NUL/)
    await expect(state.set('other', { ...shared, value: 1 })).rejects.toThrow(/only its owner writes/)
    await expect(state.set('owner', { ...shared, value: undefined })).rejects.toThrow(/JSON data/)
    await expect(state.set('owner', { ...shared, value: 'x'.repeat(4_194_304) })).rejects.toThrow(/4194304/)
    await expect(state.render('terminal\0Pane\0one', async () => state.set('owner', {
      ...shared,
      value: 1,
    }))).rejects.toThrow(/render.*pure/i)
  })

  test('admits only one concurrent writer for the same expected version', async () => {
    const state = createModState()
    await state.set('owner', { ...shared, value: 0 })
    const results = await Promise.all(Array.from({length:16}, (_, value) =>
      state.set('owner', { ...shared, value, ifVersion:1 })))
    expect(results.filter(result => result.isSet)).toHaveLength(1)
    expect(results.every(result => result.version === 2)).toBe(true)
    expect((await state.get(shared)).version).toBe(2)
  })

  test('keeps a dispatch snapshot while allowing reads of its own write', async () => {
    const state = createModState()
    await state.set('owner', { ...shared, value: 'before' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    const first = state.dispatch(async () => {
      expect(await state.get(shared)).toEqual({ value: 'before', version: 1 })
      await gate
      expect(await state.get(shared)).toEqual({ value: 'before', version: 1 })
      await state.set('owner', { ...shared, value: 'mine' })
      return state.get(shared)
    })
    await Promise.resolve()
    await state.set('owner', { ...shared, value: 'outside' })
    release()

    expect(await first).toEqual({ value: 'mine', version: 3 })
  })

  test('a CAS miss refreshes only the conflicted key for the next retry', async () => {
    const state = createModState()
    const other = {plugin:'owner', key:'other'}
    await state.set('owner', {...shared, value:1})
    await state.set('owner', {...other, value:'before'})
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const pending = state.dispatch(async () => {
      const held = await state.get(shared)
      entered.resolve()
      await resume.promise
      expect(await state.set('owner', {...shared, value:2, ifVersion:held.version})).toEqual({isSet:false, version:2})
      expect(await state.get(other)).toEqual({value:'before', version:1})
      const fresh = await state.get(shared)
      expect(fresh).toEqual({value:5, version:2})
      expect(await state.set('owner', {...shared, value:6, ifVersion:fresh.version})).toEqual({isSet:true, version:3})
      expect(await state.get(other)).toEqual({value:'before', version:1})
    })
    await entered.promise
    await state.set('owner', {...shared, value:5})
    await state.set('owner', {...other, value:'after'})
    resume.resolve()
    await pending
  })

  test('returned JSON is immutable and detached from the writer input', async () => {
    const state = createModState()
    const input = {nested:{value:1}}
    await state.set('owner', {...shared, value:input})
    input.nested.value = 2
    const read = await state.get(shared)
    expect(read.value).toEqual({nested:{value:1}})
    expect(Object.isFrozen(read.value)).toBe(true)
    expect(Object.isFrozen((read.value as typeof input).nested)).toBe(true)
  })

  test('preserves a monotonic version floor when session values reset', async () => {
    const state = createModState()
    await state.set('owner', { ...shared, value: 1 })
    await state.set('owner', { ...shared, value: 2 })
    state.reset()
    expect(await state.get(shared)).toEqual({ value: undefined, version: 0 })
    expect(await state.set('owner', { ...shared, value: 3 })).toEqual({ isSet: true, version: 3 })
  })

  test.each([undefined, 0, 1])('a dispatch from the previous session cannot write after reset (ifVersion=%s)', async ifVersion => {
    const state = createModState()
    await state.set('owner', { ...shared, value: 'old' })
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const pending = state.dispatch(async () => {
      await state.get(shared)
      entered.resolve()
      await resume.promise
      return state.set('owner', { ...shared, value: 'late', ifVersion })
    })
    await entered.promise
    state.reset()
    await state.set('owner', { ...shared, value: 'new' })
    void pending.catch(() => {})
    resume.resolve()
    await expect(pending).rejects.toThrow(/reset/)
    expect(await state.get(shared)).toEqual({ value: 'new', version: 2 })
  })

  test('tracks render reads and reports only stale instances', async () => {
    const stale: string[][] = []
    const state = createModState({ onStale: instances => stale.push([...instances]) })
    const other = { plugin: 'owner', key: 'other' }
    await state.set('owner', { ...shared, value: 1 })

    await state.render('terminal\0Pane\0first', () => state.get(shared))
    await state.render('terminal\0Pane\0second', () => state.get(other))
    await state.set('owner', { ...shared, value: 2 })

    expect(stale).toEqual([['terminal\0Pane\0first']])
    state.forgetRender('terminal\0Pane\0first')
    await state.set('owner', { ...shared, value: 3 })
    expect(stale).toHaveLength(1)
  })

  test('an older render cannot replace a newer render dependency set', async () => {
    const stale: string[][] = []
    const state = createModState({ onStale: instances => stale.push([...instances]) })
    const other = { plugin: 'owner', key: 'new' }
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const older = state.render('terminal\0Pane\0race', async () => {
      await state.get(shared)
      entered.resolve()
      await resume.promise
    })
    await entered.promise
    await state.render('terminal\0Pane\0race', () => state.get(other))
    resume.resolve()
    await older
    await state.set('owner', { ...shared, value: 1 })
    expect(stale).toEqual([])
    await state.set('owner', { ...other, value: 2 })
    expect(stale).toEqual([['terminal\0Pane\0race']])
  })

  test.each(['forget', 'reset'])('does not restore dependencies after %s during a render', async action => {
    const stale: string[][] = []
    const state = createModState({ onStale: instances => stale.push([...instances]) })
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const pending = state.render('terminal\0Pane\0retired', async () => {
      await state.get(shared)
      entered.resolve()
      await resume.promise
    })
    await entered.promise
    if (action === 'forget') state.forgetRender('terminal\0Pane\0retired')
    else state.reset()
    resume.resolve()
    await pending
    await state.set('owner', { ...shared, value: 1 })
    expect(stale).toEqual([])
  })

  test('marks a render stale when a value changes before its reads commit', async () => {
    const stale: string[][] = []
    const state = createModState({ onStale: instances => stale.push([...instances]) })
    await state.set('owner', { ...shared, value: 1 })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })

    const rendering = state.render('terminal\0Pane\0race', async () => {
      await state.get(shared)
      await gate
    })
    await Promise.resolve()
    await state.set('owner', { ...shared, value: 2 })
    release()
    await rendering

    expect(stale).toEqual([['terminal\0Pane\0race']])
  })
})
