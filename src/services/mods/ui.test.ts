import { describe, expect, test } from 'bun:test'
import {
  createModUi,
  type ModUiDispatch,
  type ModUiPane,
  type ModUiPresentation,
} from './ui.js'

const wide: ModUiPresentation = {
  columns: 160,
  rows: 40,
  isFullscreen: true,
  composerEmpty: true,
  hasDialog: false,
  keyboardOwned: false,
}

function fixture(overrides: Partial<Parameters<typeof createModUi>[0]> = {}) {
  const draws: { drawing: number; input: Record<string, unknown> }[] = []
  const invoked: { drawing: number; handle: number; args: unknown[] }[] = []
  const released: number[] = []
  const dispatch: ModUiDispatch = async (_owner, _event, input, core) => core(input)
  const ui = createModUi({
    pluginOf: owner => (owner as { plugin?: string }).plugin ?? 'fixture',
    dispatch,
    draw: async (_owner, input, drawing) => {
      draws.push({ drawing, input })
      return {
        type: 'Button',
        props: { key: 'run', label: String((input.props as { title: string }).title) },
        press: { plugin: 'fixture', handle: drawing + 10 },
      }
    },
    invokeDrawing: async (_owner, drawing, handle, args) => {
      invoked.push({ drawing, handle, args })
      return undefined
    },
    releaseDrawing: async (_owner, drawing) => {
      released.push(drawing)
    },
    ...overrides,
  })
  return { ui, draws, invoked, released }
}

describe('mod UI ownership and pane policy', () => {
  test('keeps candidates private and atomically swaps a ready replacement', async () => {
    const oldOwner = { plugin: 'fixture' }
    const failedOwner = { plugin: 'fixture' }
    const nextOwner = { plugin: 'fixture' }
    const { ui, released } = fixture()

    await ui.open(oldOwner, { id: 'diff', title: 'Old' }, { kind: 'plugin' }, wide)
    expect(ui.getSnapshot()).toEqual([])
    await ui.commit(oldOwner)
    const oldSnapshot = ui.getSnapshot()
    const oldDrawing = oldSnapshot[0]!.drawing
    expect(oldSnapshot[0]).toMatchObject({ id: 'diff', title: 'Old', visible: true })

    await ui.open(failedOwner, { id: 'diff', title: 'Failed' }, { kind: 'plugin' }, wide)
    ui.releaseCandidate(failedOwner)
    expect(ui.getSnapshot()).toBe(oldSnapshot)

    await ui.open(nextOwner, { id: 'diff', title: 'Ready' }, { kind: 'plugin' }, wide)
    expect(ui.getSnapshot()).toBe(oldSnapshot)
    await ui.commit(nextOwner, oldOwner)
    expect(ui.getSnapshot()).not.toBe(oldSnapshot)
    expect(ui.getSnapshot()).toHaveLength(1)
    expect(ui.getSnapshot()[0]).toMatchObject({ id: 'diff', title: 'Ready' })
    expect(released).toContain(oldDrawing)
  })

  test('keeps a committed pane unchanged when a same-id replacement draw fails', async () => {
    const owner = { plugin: 'fixture' }
    const { ui, released } = fixture({
      draw: async (_owner, input) => {
        const title = String((input.props as { title: string }).title)
        if (title === 'Failed') throw new Error('replacement failed')
        return { type: 'Text', props: {}, children: [title] }
      },
    })

    await ui.open(owner, { id: 'pane', title: 'Old' }, { kind: 'person' }, wide)
    await ui.commit(owner)
    const previous = ui.getSnapshot()
    const previousDrawing = previous[0]!.drawing

    await expect(
      ui.open(owner, { id: 'pane', title: 'Failed' }, { kind: 'person' }, wide),
    ).rejects.toThrow('replacement failed')
    expect(ui.getSnapshot()).toBe(previous)
    expect(ui.getSnapshot()[0]).toMatchObject({
      title: 'Old',
      drawing: previousDrawing,
      tree: { type: 'Text', props: {}, children: ['Old'] },
    })
    expect(released).not.toContain(previousDrawing)
  })

  test('publishes stable snapshots only for committed changes and rejects unrelated id takeover', async () => {
    const first = { plugin: 'one' }
    const other = { plugin: 'two' }
    const { ui } = fixture()
    const initial = ui.getSnapshot()
    const observed: unknown[] = []
    const unsubscribe = ui.subscribe(() => observed.push(ui.getSnapshot()))

    await ui.open(first, { id: 'same' }, { kind: 'plugin' }, wide)
    expect(ui.getSnapshot()).toBe(initial)
    expect(observed).toEqual([])
    await ui.commit(first)
    const committed = ui.getSnapshot()
    expect(observed).toEqual([committed])

    await ui.open(other, { id: 'same' }, { kind: 'plugin' }, wide)
    await expect(ui.commit(other)).rejects.toThrow(/already owned/i)
    expect(ui.getSnapshot()).toBe(committed)
    unsubscribe()
  })

  test('validates pane ids and open options, and same-id open updates one instance', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    await expect(ui.open(owner, { id: 'bad id' }, { kind: 'plugin' }, wide)).rejects.toThrow(/id/i)
    await expect(ui.open(owner, { id: 'ok', rows: 0 }, { kind: 'plugin' }, wide)).rejects.toThrow(/rows/i)
    await expect(ui.open(owner, { id: 'ok', focus: false as never }, { kind: 'plugin' }, wide)).rejects.toThrow(/focus/i)

    await ui.open(owner, { id: 'ok', title: 'One', closeOnEscape: true }, { kind: 'plugin' }, wide)
    await ui.open(owner, { id: 'ok', title: 'Two', rows: 7 }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    expect(ui.getSnapshot()).toHaveLength(1)
    expect(ui.getSnapshot()[0]).toMatchObject({
      id: 'ok', title: 'Two', rows: 7, closeOnEscape: false,
    })
  })

  test('applies person/autonomous width thresholds separately from placement', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    const narrow = { ...wide, columns: 100, isFullscreen: false }
    await ui.open(owner, { id: 'auto' }, { kind: 'plugin' }, narrow)
    await ui.open(owner, { id: 'asked' }, { kind: 'person' }, narrow)
    await ui.commit(owner)
    expect(ui.getSnapshot().map(pane => [pane.id, pane.visible, pane.placement])).toEqual([
      ['auto', false, 'inline'],
      ['asked', true, 'inline'],
    ])

    await ui.close(owner, 'asked', { kind: 'person' })
    await ui.open(owner, { id: 'asked' }, { kind: 'plugin' }, narrow)
    expect(ui.getSnapshot().find(pane => pane.id === 'asked')).toMatchObject({ visible: false })
    await ui.render({ ...wide, columns: 112 })
    expect(ui.getSnapshot().find(pane => pane.id === 'asked')).toMatchObject({ visible: true, placement: 'dock' })
    expect(ui.getSnapshot().find(pane => pane.id === 'auto')).toMatchObject({ visible: false })
    await ui.render({ ...wide, columns: 150 })
    expect(ui.getSnapshot().every(pane => pane.visible)).toBe(true)
  })

  test('grants requested focus only while the empty composer owns unobstructed input', async () => {
    for (const [changes, expected] of [
      [{}, true],
      [{ composerEmpty: false }, false],
      [{ hasDialog: true }, false],
      [{ keyboardOwned: true }, false],
    ] as const) {
      const owner = { plugin: 'fixture' }
      const { ui } = fixture()
      await ui.open(owner, { id: 'focus', focus: true }, { kind: 'person' }, { ...wide, ...changes })
      await ui.commit(owner)
      expect(ui.getSnapshot()[0]!.focused).toBe(expected)
    }
  })
})

describe('mod UI dispatch and drawing lifetime', () => {
  for (const mode of ['committed-open', 'hidden-to-visible'] as const) {
    test(`${mode} does not publish a visible pane before its first drawing is ready`, async () => {
      let markDrawStarted!: () => void
      let finishDraw!: () => void
      const drawStarted = new Promise<void>(resolve => {
        markDrawStarted = resolve
      })
      const drawReady = new Promise<void>(resolve => {
        finishDraw = resolve
      })
      const owner = { plugin: 'fixture' }
      const snapshots: (readonly ModUiPane[])[] = []
      const { ui } = fixture({
        draw: async () => {
          markDrawStarted()
          await drawReady
          return { type: 'Text', props: {}, children: ['ready'] }
        },
      })

      if (mode === 'hidden-to-visible') {
        await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, { ...wide, columns: 100 })
      }
      await ui.commit(owner)
      const unsubscribe = ui.subscribe(() => snapshots.push(ui.getSnapshot()))
      const operation = mode === 'committed-open'
        ? ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide)
        : ui.render(wide)

      try {
        await drawStarted
        const published = [...snapshots, ui.getSnapshot()].flat()
        expect(published.filter(pane => pane.visible && pane.tree === undefined)).toEqual([])
      } finally {
        finishDraw()
        await operation
        unsubscribe()
      }

      expect(ui.getSnapshot()[0]).toMatchObject({
        id: 'pane',
        visible: true,
        tree: { type: 'Text', props: {}, children: ['ready'] },
      })
    })
  }

  test('keeps a committed pane hidden when its first drawing fails', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture({
      draw: async () => {
        throw new Error('render failed')
      },
    })
    await ui.commit(owner)

    await expect(
      ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide),
    ).rejects.toThrow('render failed')
    expect(ui.getSnapshot()[0]).toMatchObject({ id: 'pane', visible: false })
    expect(ui.getSnapshot()[0]!.tree).toBeUndefined()
  })

  test('closes, scrolls and focuses only when middleware reaches core', async () => {
    const owner = { plugin: 'fixture' }
    let mode: 'pass' | 'veto' = 'veto'
    const actions: string[] = []
    const dispatch: ModUiDispatch = async (_owner, event, input, core) => {
      actions.push(`${event}:${mode}`)
      return mode === 'pass' ? core(input) : { deny: 'held' }
    }
    const { ui } = fixture({ dispatch })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    expect(ui.getSnapshot()).toEqual([])
    mode = 'pass'
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)

    mode = 'veto'
    await ui.scroll(owner, { requestId: 'pane', by: 5, origin: { kind: 'person' } })
    await ui.focus(owner, { requestId: 'pane', element: 'run', origin: { kind: 'person' } })
    await ui.close(owner, 'pane', { kind: 'person' })
    expect(ui.getSnapshot()[0]).toMatchObject({ scrollOffset: 0 })
    expect(ui.getSnapshot()[0]!.focusedElement).toBeUndefined()

    mode = 'pass'
    ui.reportMetrics('pane', { bodyRows: 10, contentRows: 30 })
    await ui.scroll(owner, { requestId: 'pane', by: 5, origin: { kind: 'person' } })
    await ui.focus(owner, { requestId: 'pane', element: 'run', origin: { kind: 'person' } })
    expect(ui.getSnapshot()[0]).toMatchObject({ scrollOffset: 5, focusedElement: 'run' })
    await expect(ui.focus(owner, { requestId: 'pane', element: 'missing', origin: { kind: 'person' } })).resolves.toMatchObject({ deny: expect.any(String) })
    expect(ui.getSnapshot()[0]).toMatchObject({ focusedElement: 'run' })
    await ui.focus(owner, { requestId: 'pane', origin: { kind: 'person' } })
    expect(ui.getSnapshot()[0]).toMatchObject({ focused: false })
    expect(ui.getSnapshot()[0]!.focusedElement).toBeUndefined()
    await ui.close(owner, 'pane', { kind: 'person' })
    expect(ui.getSnapshot()).toEqual([])
    expect(actions).toContain('ui.close:veto')
  })

  test('restores omitted ui.focus fields before committing a rewritten element', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture({
      draw: async () => ({
        type: 'Box',
        children: [
          { type: 'Button', props: { key: 'one', label: 'One' }, press: { plugin: 'fixture', handle: 1 } },
          { type: 'Button', props: { key: 'two', label: 'Two' }, press: { plugin: 'fixture', handle: 2 } },
        ],
      }),
      dispatch: async (_owner, event, input, core, options) => {
        if (event !== 'ui.focus') return core(input)
        const rewritten = { element: 'two' }
        return core(options.restoreInput?.(rewritten, input) ?? rewritten)
      },
    })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)

    await expect(ui.focus(owner, {
      requestId: 'pane', element: 'one', origin: { kind: 'person' },
    })).resolves.toEqual({})
    expect(ui.getSnapshot()[0]!.focusedElement).toBe('two')
  })

  test('applies only valid offset rewrites, restores omissions and pins the rest of ui.scroll input', async () => {
    const owner = { plugin: 'fixture' }
    let rewrite: Record<string, unknown> = {}
    let omit = false
    const { ui } = fixture({
      dispatch: async (_owner, event, input, core, options) => {
        if (event !== 'ui.scroll') return core(input)
        const rewritten = omit ? { offset: 4 } : { ...input, ...rewrite }
        return core(options.restoreInput?.(rewritten, input) ?? rewritten)
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide)
    await ui.commit(owner)
    ui.reportMetrics('pane', { bodyRows: 4, contentRows: 12 })

    rewrite = { offset: 3 }
    await expect(ui.scroll(owner, { requestId: 'pane', by: 1, origin: { kind: 'person' } })).resolves.toEqual({})
    expect(ui.getSnapshot()[0]!.scrollOffset).toBe(3)

    omit = true
    await expect(ui.scroll(owner, { requestId: 'pane', by: 1, origin: { kind: 'person' } })).resolves.toEqual({})
    expect(ui.getSnapshot()[0]!.scrollOffset).toBe(4)
    omit = false

    for (const offset of [-1, 1.5]) {
      rewrite = { offset }
      await expect(ui.scroll(owner, { requestId: 'pane', by: 1, origin: { kind: 'person' } })).rejects.toThrow(/offset/i)
      expect(ui.getSnapshot()[0]!.scrollOffset).toBe(4)
    }

    for (const changes of [
      { component: 'AbovePrompt' },
      { requestId: 'other' },
      { by: 9 },
      { bodyRows: 9 },
      { contentRows: 9 },
      { origin: { kind: 'plugin', name: 'fixture' } },
      { pointer: { column: 0, row: 0 } },
    ]) {
      rewrite = changes
      await expect(ui.scroll(owner, { requestId: 'pane', by: 1, origin: { kind: 'person' } })).rejects.toThrow(/rewrite/i)
      expect(ui.getSnapshot()[0]!.scrollOffset).toBe(4)
    }
  })

  test('resolves plugin scroll targets with official block placement', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    await ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide)
    await ui.commit(owner)
    ui.reportMetrics('pane', {
      bodyRows: 4,
      contentRows: 12,
      keyRows: [{ plugin: 'fixture', key: 'row', top: 6, bottom: 7 }],
    })

    await ui.reveal(owner, {
      requestId: 'pane',
      edge: 'end',
      origin: { kind: 'plugin', name: 'fixture' },
    })
    expect(ui.getSnapshot()[0]!.scrollOffset).toBe(8)
    await ui.reveal(owner, {
      requestId: 'pane',
      key: 'row',
      block: 'center',
      origin: { kind: 'plugin', name: 'fixture' },
    })
    expect(ui.getSnapshot()[0]!.scrollOffset).toBe(5)
    await expect(ui.reveal(owner, {
      requestId: 'pane',
      key: 'missing',
      origin: { kind: 'plugin', name: 'fixture' },
    })).resolves.toEqual({ deny: 'no element of its own is drawn under that key' })
  })

  test('preserves input change versus submit and avoids no-op metric publications', async () => {
    const owner = { plugin: 'fixture' }
    const observed: unknown[] = []
    const kinds: unknown[] = []
    const { ui, invoked } = fixture({
      dispatch: async (_owner, event, input, core) => {
        if (event === 'ui.input') kinds.push(input.kind)
        return core(input)
      },
      draw: async () => ({
        type: 'Input',
        props: { key: 'reply' },
        press: { plugin: 'fixture', handle: 31 },
      }),
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide)
    await ui.commit(owner)
    const current = ui.getSnapshot()[0]!
    const unsubscribe = ui.subscribe(() => observed.push(ui.getSnapshot()))
    ui.reportMetrics('pane', { bodyRows: current.bodyRows, contentRows: current.contentRows })
    expect(observed).toEqual([])

    await ui.interact('pane', current.drawing!, { plugin: 'fixture', handle: 31 }, 'input.change', 'reply', 'a')
    await ui.interact('pane', current.drawing!, { plugin: 'fixture', handle: 31 }, 'input.submit', 'reply', 'a')
    expect(kinds).toEqual(['change', 'submit'])
    expect(invoked.map(call => call.args[0])).toEqual([
      expect.objectContaining({ kind: 'change', value: 'a' }),
      expect.objectContaining({ kind: 'submit', value: 'a' }),
    ])
    unsubscribe()
  })

  test('revokes focus when another presentation owner takes the keyboard', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    expect(ui.getSnapshot()[0]!.focused).toBe(true)
    await ui.render({ ...wide, hasDialog: true })
    expect(ui.getSnapshot()[0]!.focused).toBe(false)
  })

  test('removes unload panes before dispatch, skips the opener and cannot be vetoed', async () => {
    const owner = { plugin: 'fixture' }
    const seen: { snapshotLength: number; skip: object | undefined }[] = []
    const { ui, released } = fixture({
      dispatch: async (_owner, event, input, core, options) => {
        if (event === 'ui.close') {
          seen.push({ snapshotLength: ui.getSnapshot().length, skip: options.skipOwner })
          return { deny: 'cannot restore an unload' }
        }
        return core(input)
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    const drawing = ui.getSnapshot()[0]!.drawing

    await ui.release(owner)
    expect(ui.getSnapshot()).toEqual([])
    expect(released).toContain(drawing)
    expect(seen).toEqual([{ snapshotLength: 0, skip: owner }])
  })

  test('releases stale async draws and rejects callbacks from replaced drawings', async () => {
    const owner = { plugin: 'fixture' }
    const resolvers: ((tree: unknown) => void)[] = []
    const { ui, released, invoked } = fixture({
      draw: async () => new Promise(resolve => resolvers.push(resolve)),
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    const committing = ui.commit(owner)
    expect(resolvers).toHaveLength(1)
    resolvers.shift()!({ type: 'Text', children: ['first'] })
    await committing
    const first = ui.getSnapshot()[0]!

    const older = ui.invalidate(owner, 'ui.render')
    const newer = ui.invalidate(owner, 'ui.render')
    expect(resolvers).toHaveLength(2)
    resolvers[1]!({ type: 'Button', props: { key: 'new', label: 'New' }, press: { plugin: 'fixture', handle: 22 } })
    await newer
    resolvers[0]!({ type: 'Button', props: { key: 'old', label: 'Old' }, press: { plugin: 'fixture', handle: 11 } })
    await older

    const current = ui.getSnapshot()[0]!
    expect(current.drawing).not.toBe(first.drawing)
    expect(released).toContain(first.drawing)
    await expect(ui.interact('pane', first.drawing!, { plugin: 'fixture', handle: 11 }, 'press', 'old')).rejects.toThrow(/stale/i)
    await ui.interact('pane', current.drawing!, { plugin: 'fixture', handle: 22 }, 'press', 'new')
    expect(invoked).toEqual([{ drawing: current.drawing, handle: 22, args: [expect.objectContaining({ element: 'new' })] }])
  })
})
