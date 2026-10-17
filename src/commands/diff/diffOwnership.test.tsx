import { expect, test } from 'bun:test'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import { call } from './diff.js'

function fixture(columns = 144) {
  let state = getDefaultAppState()
  let owned = false
  const completions: Parameters<LocalJSXCommandOnDone>[] = []
  const context = {
    messages: [],
    mods: { isDiffOwned: () => owned, ui: { getSnapshot: () => [] } },
    modCommand: { origin: { kind: 'composer' }, presentation: { columns, isFullscreen: true } },
    getAppState: () => state,
    setAppState: (update: (previous: AppState) => AppState) => { state = update(state) },
  } as unknown as LocalJSXCommandContext
  return { context, completions, state: () => state, own: () => { owned = true },
    done: (...args: Parameters<LocalJSXCommandOnDone>) => { completions.push(args) } }
}

test('an already selected native diff command yields before changing the owned UI or preferences', async () => {
  const f = fixture()
  let refreshes = 0, preferences = 0
  f.context.setAppState(state => ({ ...state, diffSidebarVisible: true }))
  f.context.diff = { refresh: async () => { refreshes++ }, setOpenPreference: () => { preferences++ } } as unknown as NonNullable<LocalJSXCommandContext['diff']>
  f.own()
  expect(await call(f.done, f.context, '')).toBeNull()
  expect(f.state().diffSidebarVisible).toBe(true)
  expect({ refreshes, preferences }).toEqual({ refreshes: 0, preferences: 0 })
  expect(f.completions).toEqual([[undefined, { display: 'skip' }]])
})

test('ownership gained while probing git prevents a delayed native sidebar opening', async () => {
  const f = fixture()
  const pending = call(f.done, f.context, '')
  f.own()
  expect(await pending).toBeNull()
  expect(f.state().diffSidebarVisible).toBe(false)
  expect(f.completions).toEqual([[undefined, { display: 'skip' }]])
})

test('ownership gained while refreshing a narrow diff prevents the native dialog and stale error', async () => {
  const f = fixture(80)
  const entered = Promise.withResolvers<void>(), refreshed = Promise.withResolvers<void>()
  let reads = 0
  f.context.diff = {
    refresh: () => { entered.resolve(); return refreshed.promise },
    getSnapshot: () => { reads++; return { data: { outcome: 'unavailable', error: 'stale git failure' } } },
    setOpenPreference: () => {},
  } as unknown as NonNullable<LocalJSXCommandContext['diff']>
  const pending = call(f.done, f.context, '')
  await entered.promise
  f.own(); refreshed.resolve()
  expect(await pending).toBeNull()
  expect(reads).toBe(0)
  expect(f.state().diffSidebarVisible).toBe(false)
  expect(f.completions).toEqual([[undefined, { display: 'skip' }]])
})

test('ownership gained during the native dialog import prevents a stale modal', async () => {
  const f = fixture(80)
  f.context.diff = { refresh: async () => {}, getSnapshot: () => ({ data: { outcome: 'data' } }) } as unknown as NonNullable<LocalJSXCommandContext['diff']>
  const pending = call(f.done, f.context, '')
  // The refresh reaction runs first and starts import; ownership changes before it settles.
  await Promise.resolve()
  f.own()
  expect(await pending).toBeNull()
  expect(f.completions).toEqual([[undefined, { display: 'skip' }]])
})

test('a native refresh settled after ownership changes cannot post stale failure notifications', async () => {
  const f = fixture()
  const refreshed = Promise.withResolvers<void>()
  const notifications: unknown[] = []
  let reads = 0
  f.context.addNotification = value => { notifications.push(value) }
  f.context.diff = {
    refresh: () => refreshed.promise,
    getSnapshot: () => { reads++; return { data: { outcome: 'unavailable', error: 'stale git failure' } } },
    setOpenPreference: () => {},
  } as unknown as NonNullable<LocalJSXCommandContext['diff']>
  expect(await call(f.done, f.context, '')).toBeNull()
  f.own(); refreshed.resolve(); await refreshed.promise
  expect(reads).toBe(0)
  expect(notifications).toEqual([])
  expect(f.completions).toEqual([['Diff panel shown', { display: 'system' }]])
})
