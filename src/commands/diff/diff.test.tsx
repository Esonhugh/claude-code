import { describe, expect, mock, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { getIsGit } from '../../utils/git.js'
import { call } from './diff.js'
import diffCommand from './index.js'
import { isCommandImmediate } from '../../types/command.js'

function createContext(
  presentation: { columns: number; isFullscreen: boolean },
) {
  let state = getDefaultAppState()
  const context = {
    messages: [],
    modCommand: { origin: { kind: 'composer' }, presentation },
    getAppState: () => state,
    setAppState: (updater: (previous: AppState) => AppState) => {
      state = updater(state)
    },
  } as unknown as LocalJSXCommandContext
  return { context, getState: () => state }
}

describe('/diff', () => {
  test('wide diff panels bypass the active turn queue in either renderer', () => {
    const fullscreen = createContext({ columns: 144, isFullscreen: true }).context
    const defaultRenderer = createContext({ columns: 144, isFullscreen: false }).context
    const narrow = createContext({ columns: 109, isFullscreen: false }).context
    expect(isCommandImmediate(diffCommand, '', fullscreen)).toBe(true)
    expect(isCommandImmediate(diffCommand, '', defaultRenderer)).toBe(true)
    expect(isCommandImmediate(diffCommand, '', narrow)).toBe(false)
  })

  test('opens the native sidebar before the shared controller refresh completes', async () => {
    const { context, getState } = createContext({ columns: 144, isFullscreen: true })
    let resolveRefresh!: () => void
    let refreshStarted = false
    const refresh = new Promise<void>(resolve => { resolveRefresh = resolve })
    const saved: boolean[] = []
    context.diff = {
      refresh: () => {
        refreshStarted = true
        return refresh
      },
      getSnapshot: () => ({ data: { stats: null, files: [], hunks: new Map(), loading: true } }),
      setOpenPreference: (value: boolean) => saved.push(value),
    } as unknown as NonNullable<LocalJSXCommandContext['diff']>
    const completions: Parameters<LocalJSXCommandOnDone>[] = []

    const result = await call((...args) => completions.push(args), context, '')

    expect(result).toBeNull()
    expect(refreshStarted).toBe(true)
    expect(getState().diffSidebarVisible).toBe(true)
    expect(saved).toEqual([true])
    expect(completions).toEqual([
      ['Diff panel shown', { display: 'system' }],
    ])
    resolveRefresh()
    await refresh
  })

  test('reports a delayed refresh failure without hiding the open sidebar', async () => {
    const { context, getState } = createContext({ columns: 144, isFullscreen: true })
    let resolveRefresh!: () => void
    const refresh = new Promise<void>(resolve => { resolveRefresh = resolve })
    let data = { outcome: undefined, error: undefined } as {
      outcome?: 'unavailable'
      error?: string
    }
    context.diff = {
      refresh: () => refresh,
      getSnapshot: () => ({ data }),
      setOpenPreference: () => {},
    } as unknown as NonNullable<LocalJSXCommandContext['diff']>
    const addNotification = mock(() => {})
    context.addNotification = addNotification
    const completions: Parameters<LocalJSXCommandOnDone>[] = []

    await call((...args) => completions.push(args), context, '')
    data = { outcome: 'unavailable', error: 'Git probe failed' }
    resolveRefresh()
    await refresh
    await Promise.resolve()

    expect(getState().diffSidebarVisible).toBe(true)
    expect(completions).toEqual([
      ['Diff panel shown', { display: 'system' }],
    ])
    expect(addNotification).toHaveBeenCalledWith({
      key: 'diff-refresh',
      text: 'Diff is unavailable: Git probe failed',
      priority: 'medium',
    })
  })

  test('opens the native sidebar in a wide fullscreen terminal', async () => {
    const { context, getState } = createContext({
      columns: 110,
      isFullscreen: true,
    })
    const completions: Parameters<LocalJSXCommandOnDone>[] = []

    const result = await call((...args) => completions.push(args), context, '')

    expect(result).toBeNull()
    expect(getState().diffSidebarVisible).toBe(true)
    expect(completions).toEqual([
      ['Diff panel shown', { display: 'system' }],
    ])
  })

  test('replaces a hidden narrow sidebar with the diff dialog', async () => {
    const { context, getState } = createContext({
      columns: 110,
      isFullscreen: true,
    })
    const saved: boolean[] = []
    context.diff = {
      refresh: async () => {},
      getSnapshot: () => ({ data: { outcome: 'data' } }),
      setOpenPreference: (value: boolean) => saved.push(value),
    } as unknown as NonNullable<LocalJSXCommandContext['diff']>
    await call(() => {}, context, '')
    context.modCommand = {
      origin: { kind: 'composer' },
      presentation: { columns: 80, isFullscreen: true },
    }
    const completions: Parameters<LocalJSXCommandOnDone>[] = []

    const result = await call((...args) => completions.push(args), context, '')

    expect(getState().diffSidebarVisible).toBe(false)
    expect(saved).toEqual([true, false])
    expect(result).toMatchObject({ props: { messages: context.messages } })
    expect(completions).toEqual([])
  })

  test('keeps a visible Mods dock and falls back to DiffDialog', async () => {
    const { context, getState } = createContext({
      columns: 160,
      isFullscreen: true,
    })
    const dock = { visible: true, placement: 'dock', focused: true }
    const getSnapshot = mock(() => [dock])
    const addNotification = mock(() => {})
    context.mods = {
      ui: { getSnapshot },
    } as unknown as LocalJSXCommandContext['mods']
    context.addNotification = addNotification
    const completions: Parameters<LocalJSXCommandOnDone>[] = []

    const result = await call((...args) => completions.push(args), context, '')

    expect(getSnapshot).toHaveBeenCalledTimes(1)
    expect(getState().diffSidebarVisible).toBe(false)
    expect(result).toMatchObject({
      props: { messages: context.messages },
    })
    expect(completions).toEqual([])
    expect(addNotification).toHaveBeenCalledWith({
      key: 'diff-sidebar-mod-dock',
      text: 'A Mods dock is visible; opened the diff dialog instead.',
      priority: 'medium',
    })
    expect(dock).toEqual({ visible: true, placement: 'dock', focused: true })
  })

  test('opens a non-modal panel in a wide default renderer', async () => {
    const { context, getState } = createContext({
      columns: 160,
      isFullscreen: false,
    })
    const completions: Parameters<LocalJSXCommandOnDone>[] = []

    const result = await call((...args) => completions.push(args), context, '')

    expect(result).toBeNull()
    expect(getState().diffSidebarVisible).toBe(true)
    expect(completions).toEqual([
      ['Diff panel shown', { display: 'system' }],
    ])
  })

  test('uses DiffDialog in a narrow terminal', async () => {
    const { context, getState } = createContext({
      columns: 109,
      isFullscreen: true,
    })
    const completions: Parameters<LocalJSXCommandOnDone>[] = []

    const result = await call((...args) => completions.push(args), context, '')

    expect(getState().diffSidebarVisible).toBe(false)
    expect(result).toMatchObject({ props: { messages: context.messages } })
    expect(completions).toEqual([])
  })

  test('reports a clear error outside a git repository', async () => {
    const directory = join(
      tmpdir(),
      `diff-command-non-git-${process.pid}-${Date.now()}`,
    )
    await mkdir(directory)
    try {
      getIsGit.cache.clear?.()
      await runWithCwdOverride(directory, async () => {
        const { context, getState } = createContext({
          columns: 160,
          isFullscreen: true,
        })
        const completions: Parameters<LocalJSXCommandOnDone>[] = []

        const result = await call(
          (...args) => completions.push(args),
          context,
          '',
        )

        expect(result).toBeNull()
        expect(getState().diffSidebarVisible).toBe(false)
        expect(completions).toEqual([
          [
            'Diff is unavailable outside a git repository.',
            { display: 'system' },
          ],
        ])
      })
    } finally {
      getIsGit.cache.clear?.()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
