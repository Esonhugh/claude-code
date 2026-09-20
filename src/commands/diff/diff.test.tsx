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
  test('only fullscreen diff bypasses the active turn queue', () => {
    const fullscreen = createContext({ columns: 144, isFullscreen: true }).context
    const inline = createContext({ columns: 144, isFullscreen: false }).context
    expect(isCommandImmediate(diffCommand, '', fullscreen)).toBe(true)
    expect(isCommandImmediate(diffCommand, '', inline)).toBe(false)
  })

  test('prepares the shared controller before opening and preserves failure feedback', async () => {
    const { context, getState } = createContext({ columns: 144, isFullscreen: true })
    let ready = false
    const saved: boolean[] = []
    context.diff = {
      refresh: async () => { ready = true },
      getSnapshot: () => ({ data: { outcome: 'unavailable', error: 'Git probe failed' } }),
      setOpenPreference: (value: boolean) => saved.push(value),
    } as unknown as NonNullable<LocalJSXCommandContext['diff']>
    const completions: Parameters<LocalJSXCommandOnDone>[] = []
    await call((...args) => completions.push(args), context, '')
    expect(ready).toBe(true)
    expect(getState().diffSidebarVisible).toBe(false)
    expect(completions[0]?.[0]).toContain('Git probe failed')
    expect(saved).toEqual([])
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
      ['Diff sidebar shown', { display: 'system' }],
    ])
  })

  test('closes an open sidebar after the terminal becomes narrow', async () => {
    const { context, getState } = createContext({
      columns: 110,
      isFullscreen: true,
    })
    await call(() => {}, context, '')
    context.modCommand = {
      origin: { kind: 'composer' },
      presentation: { columns: 80, isFullscreen: true },
    }
    const completions: Parameters<LocalJSXCommandOnDone>[] = []

    const result = await call((...args) => completions.push(args), context, '')

    expect(result).toBeNull()
    expect(getState().diffSidebarVisible).toBe(false)
    expect(completions).toEqual([
      ['Diff sidebar hidden', { display: 'system' }],
    ])
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

  test.each([
    { columns: 109, isFullscreen: true },
    { columns: 160, isFullscreen: false },
  ])('uses DiffDialog outside a wide fullscreen terminal', async presentation => {
    const { context, getState } = createContext(presentation)
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
