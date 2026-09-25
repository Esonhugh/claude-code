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
  test('folds Raster and byte or file Image blits to the last payload per frame but publishes every shm blit', async () => {
    const owner = { plugin: 'fixture' }
    const source = { file: '/tmp/first.png', format: 'png' }
    const { ui } = fixture({
      draw: async () => ({
        type: 'Image',
        props: { key: 'view', source, columns: 8, rows: 2, alt: 'preview' },
        group: { plugin: 'fixture' },
      }),
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide)
    await ui.commit(owner)
    const frames: unknown[] = []
    const unsubscribe = ui.subscribe(() => {
      frames.push((ui.getSnapshot()[0]!.tree as { props: { source: unknown } }).props.source)
    })

    const first = ui.blit(owner, {
      requestId: 'pane', key: 'view',
      source: { file: '/tmp/second.png', format: 'png' },
    })
    const last = ui.blit(owner, {
      requestId: 'pane', key: 'view',
      source: { file: '/tmp/third.png', format: 'png' },
    })
    await Promise.all([first, last])
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ file: '/tmp/third.png' })

    const cells = (character: string) => {
      const bytes = Buffer.alloc(12)
      bytes.writeUInt32LE(character.charCodeAt(0), 0)
      bytes.writeUInt32LE(0x01000000, 4)
      bytes.writeUInt32LE(0x01000000, 8)
      return bytes.toString('base64')
    }
    const rasterOwner = { plugin: 'raster' }
    const raster = fixture({
      pluginOf: current => (current as { plugin: string }).plugin,
      draw: async () => ({
        type: 'Raster',
        props: { key: 'pixels', cells: cells('A'), columns: 1, rows: 1 },
        group: { plugin: 'raster' },
      }),
    }).ui
    await raster.open(rasterOwner, { id: 'raster' }, { kind: 'person' }, wide)
    await raster.commit(rasterOwner)
    let rasterFrames = 0
    raster.subscribe(() => { rasterFrames++ })
    await Promise.all([
      raster.blit(rasterOwner, { requestId: 'raster', key: 'pixels', cells: cells('B') }),
      raster.blit(rasterOwner, { requestId: 'raster', key: 'pixels', cells: cells('C') }),
    ])
    expect(rasterFrames).toBe(1)
    expect((raster.getSnapshot()[0]!.tree as { props: { cells: string } }).props.cells).toBe(cells('C'))

    frames.length = 0
    await Promise.all([
      ui.blit(owner, {
        requestId: 'pane', key: 'view',
        source: { shm: '/frame-1', format: 'rgb', width: 1, height: 1 },
      }),
      ui.blit(owner, {
        requestId: 'pane', key: 'view',
        source: { shm: '/frame-2', format: 'rgb', width: 1, height: 1 },
      }),
    ])
    expect(frames).toHaveLength(2)
    expect(frames).toEqual([
      expect.objectContaining({ shm: '/frame-1' }),
      expect.objectContaining({ shm: '/frame-2' }),
    ])
    unsubscribe()
  })

  test('does not let an older async blit overwrite a newer source', async () => {
    const owner = { plugin: 'fixture' }
    let releaseFirst: (() => void) | undefined
    const firstDispatch = new Promise<void>(resolve => { releaseFirst = resolve })
    const dispatch: ModUiDispatch = async (_owner, event, input, core) => {
      const source = (input as { source?: { file?: string } }).source
      if (event === 'ui.blit' && source?.file === '/tmp/second.png')
        await firstDispatch
      return core(input)
    }
    const { ui } = fixture({
      dispatch,
      draw: async () => ({
        type: 'Image',
        props: {
          key: 'view',
          source: { file: '/tmp/first.png', format: 'png' },
          columns: 8,
          rows: 2,
          alt: 'preview',
        },
        group: { plugin: 'fixture' },
      }),
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide)
    await ui.commit(owner)

    const older = ui.blit(owner, {
      requestId: 'pane', key: 'view',
      source: { file: '/tmp/second.png', format: 'png' },
    })
    const newer = ui.blit(owner, {
      requestId: 'pane', key: 'view',
      source: { file: '/tmp/third.png', format: 'png' },
    })
    await newer
    releaseFirst?.()
    await older

    expect((ui.getSnapshot()[0]!.tree as { props: { source: unknown } }).props.source)
      .toMatchObject({ file: '/tmp/third.png' })
  })


  test('treats columns as a positive dock body-width request and resets it on every open', async () => {
    const owner = { plugin: 'fixture' }
    const { ui, draws } = fixture()
    for (const columns of [0, -1, 1.5, Number.NaN]) {
      await expect(ui.open(owner, { id: 'pane', columns }, { kind: 'person' }, wide))
        .rejects.toThrow(/columns.*positive integer/i)
    }

    await ui.open(owner, { id: 'pane', columns: 70 }, { kind: 'person' }, wide)
    await ui.commit(owner)
    expect(ui.getSnapshot()[0]).toMatchObject({ columns: 70, bodyColumns: 70 })
    expect(draws.at(-1)!.input.props).toMatchObject({ bodyColumns: 70 })
    await ui.render({ ...wide, columns: 110 })
    expect(ui.getSnapshot()[0]).toMatchObject({ columns: 70, bodyColumns: 53 })
    expect(draws.at(-1)!.input.props).toMatchObject({ bodyColumns: 53 })

    const inline = { ...wide, isFullscreen: false, columns: 90 }
    await ui.open(owner, { id: 'pane', columns: 33 }, { kind: 'plugin' }, inline)
    expect(ui.getSnapshot()[0]).toMatchObject({ columns: 33, placement: 'inline', bodyColumns: 86 })
    expect(draws.at(-1)!.input.props).toMatchObject({ bodyColumns: 86 })

    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    expect(ui.getSnapshot()[0]).not.toHaveProperty('columns')
    expect(ui.getSnapshot()[0]).toMatchObject({ placement: 'dock', bodyColumns: 78 })
    expect(draws.at(-1)!.input.props).toMatchObject({ bodyColumns: 78 })
  })

  test('keeps open panes as tabs while exposing one shown pane selected through person focus', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    await ui.open(owner, { id: 'first' }, { kind: 'plugin' }, wide)
    await ui.open(owner, { id: 'second' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    expect(ui.getSnapshot().map(pane => [pane.id, pane.visible, pane.shown])).toEqual([
      ['first', true, true], ['second', true, false],
    ])

    await expect(ui.focus(owner, {
      requestId: 'second', origin: { kind: 'person' },
    }, { ...wide, hasDialog: true })).resolves.toMatchObject({ focused: false, deny: 'site does not hold the keyboard' })
    expect(ui.getSnapshot().find(pane => pane.shown)?.id).toBe('first')
    await expect(ui.focus(owner, {
      requestId: 'second', origin: { kind: 'person' },
    }, wide)).resolves.toEqual({ focused: true })
    expect(ui.getSnapshot().map(pane => [pane.id, pane.visible, pane.shown])).toEqual([
      ['first', true, false], ['second', true, true],
    ])

    await ui.close(owner, 'second', { kind: 'person' })
    expect(ui.getSnapshot()).toHaveLength(1)
    expect(ui.getSnapshot()[0]).toMatchObject({ id: 'first', visible: true, shown: true })

    await ui.open(owner, { id: 'second' }, { kind: 'person' }, wide)
    expect(ui.getSnapshot().map(pane => [pane.id, pane.shown])).toEqual([
      ['first', false], ['second', true],
    ])
  })

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

  test('publishes the same body width used by drawing across dock and inline resize', async () => {
    const owner = { plugin: 'fixture' }
    const { ui, draws } = fixture()
    await ui.open(owner, { id: 'diff', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    await ui.focus(owner, { requestId: 'diff', element: 'run', origin: { kind: 'person' } })
    for (const columns of [160, 110, 109, 80, 160]) {
      await ui.render({ ...wide, columns, rows: 12 })
      const bodyColumns = columns >= 110 ? Math.floor(columns / 2) - 2 : columns - 4
      expect(ui.getSnapshot()[0]).toMatchObject({ bodyColumns, focusedElement: 'run', focused: true })
      expect(draws.at(-1)?.input.props).toMatchObject({ bodyColumns })
    }
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

  test('keeps a person-opened pane visible through plugin resize and reopen at 96 columns', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    const initial = { ...wide, columns: 120 }
    const narrow = { ...wide, columns: 96 }
    await ui.open(owner, { id: 'asked', rows: 6 }, { kind: 'person' }, initial)
    await ui.commit(owner)
    expect(ui.getSnapshot()[0]).toMatchObject({ visible: true, focused: false, placement: 'dock' })

    await ui.open(owner, { id: 'asked', rows: 7 }, { kind: 'plugin' }, initial)
    await ui.render(narrow)
    expect(ui.getSnapshot()[0]).toMatchObject({ visible: true, focused: false, placement: 'inline', rows: 7 })
    await ui.open(owner, { id: 'asked', title: 'Loaded', rows: 8 }, { kind: 'plugin' }, narrow)
    expect(ui.getSnapshot()[0]).toMatchObject({ visible: true, focused: false, title: 'Loaded', rows: 8 })

    await ui.open(owner, { id: 'auto' }, { kind: 'plugin' }, narrow)
    expect(ui.getSnapshot().find(pane => pane.id === 'auto')).toMatchObject({ visible: false, focused: false })
    await ui.render(initial)
    expect(ui.getSnapshot().find(pane => pane.id === 'auto')).toMatchObject({ visible: false })
    await ui.render({ ...wide, columns: 144 })
    expect(ui.getSnapshot().find(pane => pane.id === 'auto')).toMatchObject({ visible: true, focused: false })
  })

  for (const end of ['close', 'unload', 'reload', 'candidate-release'] as const) {
    test(`does not inherit person-opened visibility or focus after ${end}`, async () => {
      const owner = { plugin: 'fixture' }
      const { ui } = fixture()
      const narrow = { ...wide, columns: 96 }
      await ui.open(owner, { id: 'asked', focus: true }, { kind: 'person' }, { ...wide, columns: 120 })
      if (end !== 'candidate-release') {
        await ui.commit(owner)
        expect(ui.getSnapshot()[0]).toMatchObject({ visible: true, focused: true })
      }

      if (end === 'close') await ui.close(owner, 'asked', { kind: 'person' })
      else if (end === 'unload') await ui.release(owner)
      else if (end === 'candidate-release') ui.releaseCandidate(owner)
      const nextOwner = end === 'reload' ? { plugin: 'fixture' } : owner
      await ui.open(nextOwner, { id: 'asked' }, { kind: 'plugin' }, narrow)
      if (end !== 'close') await ui.commit(nextOwner, end === 'reload' ? owner : undefined)
      expect(ui.getSnapshot()).toHaveLength(1)
      expect(ui.getSnapshot()[0]).toMatchObject({ owner: nextOwner, visible: false, focused: false })
      expect(ui.getSnapshot()[0]!.focusedElement).toBeUndefined()
    })
  }

  test('preserves existing focus and element when reopening only to resize an inline pane', async () => {
    const owner = { plugin: 'fixture' }
    const { ui, draws } = fixture()
    const inline = { ...wide, isFullscreen: false }
    await ui.open(owner, { id: 'diff', focus: true, rows: 6 }, { kind: 'person' }, inline)
    await ui.commit(owner)
    await ui.focus(owner, { requestId: 'diff', element: 'run', origin: { kind: 'person' } })

    await ui.open(owner, { id: 'diff', title: 'Loaded diff', rows: 7 }, { kind: 'plugin' }, inline)
    expect(ui.getSnapshot()).toHaveLength(1)
    expect(ui.getSnapshot()[0]).toMatchObject({
      title: 'Loaded diff', focused: true, focusedElement: 'run', rows: 7,
    })
    expect(draws.at(-1)!.input.props).toMatchObject({ isFocused: true })

    await ui.focus(owner, { requestId: 'diff', origin: { kind: 'person' } })
    await ui.open(owner, { id: 'diff', rows: 8 }, { kind: 'plugin' }, inline)
    expect(ui.getSnapshot()[0]!.focused).toBe(false)
    expect(ui.getSnapshot()[0]!.focusedElement).toBeUndefined()
  })

  test('reopening without focus never steals input or overrides presentation restrictions', async () => {
    for (const changes of [
      { composerEmpty: false }, { hasDialog: true }, { keyboardOwned: true },
    ]) {
      const owner = { plugin: 'fixture' }
      const { ui } = fixture()
      await ui.open(owner, { id: 'diff', focus: true }, { kind: 'person' }, { ...wide, ...changes })
      await ui.commit(owner)
      expect(ui.getSnapshot()[0]!.focused).toBe(false)
      await ui.open(owner, { id: 'diff', rows: 7 }, { kind: 'plugin' }, wide)
      expect(ui.getSnapshot()[0]!.focused).toBe(false)
      await ui.open(owner, { id: 'diff', focus: true }, { kind: 'person' }, wide)
      expect(ui.getSnapshot()[0]!.focused).toBe(true)
      await ui.open(owner, { id: 'diff', rows: 8 }, { kind: 'plugin' }, { ...wide, ...changes })
      expect(ui.getSnapshot()[0]!.focused).toBe(false)
    }
  })

  test('person focus enters a visible unfocused pane and transfers keyboard ownership', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    await ui.open(owner, { id: 'first', focus: true }, { kind: 'person' }, wide)
    await ui.open(owner, { id: 'dock' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    await ui.focus(owner, { requestId: 'first', element: 'run', origin: { kind: 'person' } })

    await expect(ui.focus(owner, {
      requestId: 'dock', element: 'run', origin: { kind: 'person' },
    }, wide)).resolves.toEqual({ focused: true, element: 'run' })
    expect(ui.getSnapshot().map(pane => [pane.id, pane.focused, pane.focusedElement])).toEqual([
      ['first', false, undefined], ['dock', true, 'run'],
    ])
    await expect(ui.focus(owner, {
      requestId: 'dock', origin: { kind: 'person' },
    }, wide)).resolves.toEqual({ focused: false })
    expect(ui.getSnapshot().every(pane => !pane.focused)).toBe(true)
  })

  test('person focus uses the current host presentation and cannot enter hidden or undrawn panes', async () => {
    for (const changes of [
      { composerEmpty: false }, { hasDialog: true }, { keyboardOwned: true },
    ]) {
      const owner = { plugin: 'fixture' }
      const { ui } = fixture()
      await ui.open(owner, { id: 'dock' }, { kind: 'plugin' }, wide)
      await ui.commit(owner)
      await expect(ui.focus(owner, {
        requestId: 'dock', element: 'run', origin: { kind: 'person' },
      }, { ...wide, ...changes })).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
      expect(ui.getSnapshot()[0]!.focused).toBe(false)
      await expect(ui.focus(owner, {
        requestId: 'dock', element: 'run', origin: { kind: 'person' },
      }, wide)).resolves.toEqual({ focused: true, element: 'run' })
    }

    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    await ui.open(owner, { id: 'hidden' }, { kind: 'plugin' }, { ...wide, columns: 100 })
    await ui.commit(owner)
    await expect(ui.focus(owner, {
      requestId: 'hidden', element: 'run', origin: { kind: 'person' },
    })).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
    expect(ui.getSnapshot()[0]).toMatchObject({ visible: false, focused: false })

    const broken = fixture({ draw: async () => { throw new Error('draw failed') } }).ui
    await broken.commit(owner)
    await expect(broken.open(owner, { id: 'undrawn', focus: true }, { kind: 'person' }, wide)).rejects.toThrow('draw failed')
    await expect(broken.focus(owner, {
      requestId: 'undrawn', element: 'run', origin: { kind: 'person' },
    }, wide)).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
  })

  test('person focus reports no landing when the current presentation blocks an already focused pane', async () => {
    for (const changes of [
      { composerEmpty: false }, { hasDialog: true }, { keyboardOwned: true },
    ]) {
      const owner = { plugin: 'fixture' }
      const { ui } = fixture()
      await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
      await ui.commit(owner)
      await ui.focus(owner, { requestId: 'pane', element: 'run', origin: { kind: 'person' } })
      await expect(ui.focus(owner, {
        requestId: 'pane', element: 'run', origin: { kind: 'person' },
      }, { ...wide, ...changes })).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
      expect(ui.getSnapshot()[0]!.focused).toBe(false)
      await expect(ui.focus(owner, {
        requestId: 'pane', element: 'run', origin: { kind: 'plugin', name: 'fixture' },
      })).resolves.toEqual({ deny: 'site does not hold the keyboard' })
    }
  })

  test('plugin focus still cannot acquire keyboard ownership from the composer or another pane', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture()
    await ui.open(owner, { id: 'dock' }, { kind: 'plugin' }, wide)
    await ui.open(owner, { id: 'current', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    await ui.focus(owner, { requestId: 'current', element: 'run', origin: { kind: 'person' } })
    await expect(ui.focus(owner, {
      requestId: 'dock', element: 'run', origin: { kind: 'plugin', name: 'fixture' },
    })).resolves.toEqual({ deny: 'site does not hold the keyboard' })
    expect(ui.getSnapshot().map(pane => [pane.id, pane.focused])).toEqual([
      ['dock', false], ['current', true],
    ])
    await ui.focus(owner, { requestId: 'current', origin: { kind: 'person' } })
    await expect(ui.focus(owner, {
      requestId: 'dock', element: 'run', origin: { kind: 'plugin', name: 'fixture' },
    })).resolves.toEqual({ deny: 'site does not hold the keyboard' })
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
    await ui.reportMetrics('pane', { bodyRows: 10, contentRows: 30 })
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
    })).resolves.toEqual({ focused: true, element: 'two' })
    expect(ui.getSnapshot()[0]!.focusedElement).toBe('two')
  })

  test('reports the actual person landing for middleware rewrite, deny, stay and no-op', async () => {
    const owner = { plugin: 'fixture' }
    let mode: 'rewrite' | 'deny' | 'stay' | 'pass' = 'rewrite'
    const { ui } = fixture({
      draw: async () => ({
        type: 'Box',
        children: ['one', 'two'].map((key, index) => ({
          type: 'Button', props: { key, label: key }, press: { plugin: 'fixture', handle: index + 1 },
        })),
      }),
      dispatch: async (_owner, event, input, core, options) => {
        if (event !== 'ui.focus') return core(input)
        if (mode === 'deny') return { deny: 'held', focused: true, element: 'one' }
        if (mode === 'stay') return { stay: true }
        const rewritten = mode === 'rewrite' ? { element: 'two' } : input
        return core(options.restoreInput?.(rewritten, input) ?? rewritten)
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    mode = 'deny'
    await expect(ui.focus(owner, {
      requestId: 'pane', element: 'one', origin: { kind: 'person' },
    }, wide)).resolves.toEqual({ deny: 'held', focused: false })
    expect(ui.getSnapshot()[0]!.focused).toBe(false)
    mode = 'rewrite'
    await expect(ui.focus(owner, {
      requestId: 'pane', element: 'one', origin: { kind: 'person' },
    }, wide)).resolves.toEqual({ focused: true, element: 'two' })
    const landed = ui.getSnapshot()
    for (const [nextMode, expected] of [
      ['deny', { deny: 'held', focused: true, element: 'two' }],
      ['stay', { stay: true, focused: true, element: 'two' }],
      ['pass', { focused: true, element: 'two' }],
    ] as const) {
      mode = nextMode
      await expect(ui.focus(owner, {
        requestId: 'pane', element: nextMode === 'pass' ? 'two' : 'one', origin: { kind: 'person' },
      }, wide)).resolves.toEqual(expected)
      expect(ui.getSnapshot()).toBe(landed)
    }
    await expect(ui.focus(owner, {
      requestId: 'missing', element: 'one', origin: { kind: 'person' },
    }, wide)).resolves.toEqual({ deny: 'site is not open', focused: false })
  })

  test('person focus waits for an already-started invalidation before returning its landing', async () => {
    const owner = { plugin: 'fixture' }
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    let delay = false
    let invalidating: Promise<void> | undefined
    const { ui } = fixture({
      draw: async () => {
        if (delay) { entered.resolve(); await proceed.promise }
        return { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }
      },
      dispatch: async (_owner, event, input, core) => {
        if (event === 'ui.focus' && input.element !== undefined)
          invalidating = ui.invalidate(owner, 'ui.render')
        return core(input)
      },
    })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    const before = ui.getSnapshot()[0]!.drawing
    delay = true
    let finished = false
    const focusing = ui.focus(owner, { requestId: 'pane', element: 'run', origin: { kind: 'person' } }, wide)
      .then(result => { finished = true; return result })
    try {
      await entered.promise
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(finished).toBe(false)
      proceed.resolve()
      await expect(focusing).resolves.toEqual({ focused: true, element: 'run' })
      expect(ui.getSnapshot()[0]!.drawing).not.toBe(before)
    } finally {
      proceed.resolve()
      await Promise.all([focusing, invalidating])
      await ui.release(owner)
    }
  })

  test('person focus follows a superseding redraw without blocking Escape', async () => {
    const owner = { plugin: 'fixture' }
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let draws = 0
    let invalidating: Promise<void> | undefined
    const { ui } = fixture({
      draw: async () => {
        if (++draws === 2) { entered.resolve(); await first.promise }
        else if (draws === 3) await second.promise
        return { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }
      },
      dispatch: async (_owner, event, input, core) => {
        if (event === 'ui.focus' && input.element !== undefined)
          invalidating = ui.invalidate(owner, 'ui.render')
        return core(input)
      },
    })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    let finished = false
    const focusing = ui.focus(owner, { requestId: 'pane', element: 'run', origin: { kind: 'person' } }, wide)
      .then(result => { finished = true; return result })
    await entered.promise
    const replacing = ui.render({ ...wide, columns: 109 })
    try {
      first.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(finished).toBe(false)
      await expect(ui.focus(owner, { requestId: 'pane', origin: { kind: 'person' } }, wide)).resolves.toEqual({ focused: false })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(finished).toBe(true)
      await expect(focusing).resolves.toMatchObject({ focused: false })
      second.resolve()
      await replacing
      expect(ui.getSnapshot()[0]!.drawing).toBe(3)
    } finally {
      first.resolve(); second.resolve()
      await Promise.all([focusing, invalidating, replacing])
      await ui.release(owner)
    }
  })

  test('person focus finishes after Escape and can reenter while the old draw stays pending', async () => {
    const owner = { plugin: 'fixture' }
    const pending = new Promise<never>(() => {})
    let draws = 0
    const { ui } = fixture({
      draw: async () => {
        if (++draws === 2) return pending
        return { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }
      },
      dispatch: async (_owner, event, input, core) => {
        if (event === 'ui.focus' && input.element !== undefined)
          void ui.invalidate(owner, 'ui.render')
        return core(input)
      },
    })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    let finished = false
    const focusing = ui.focus(owner, {
      requestId: 'pane', element: 'run', origin: { kind: 'person' },
    }, wide).then(result => { finished = true; return result })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(draws).toBe(2)
      expect(finished).toBe(false)
      await expect(ui.focus(owner, {
        requestId: 'pane', origin: { kind: 'person' },
      }, wide)).resolves.toEqual({ focused: false })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(finished).toBe(true)
      await expect(focusing).resolves.toEqual({ focused: false })
      await expect(ui.focus(owner, {
        requestId: 'pane', element: 'run', origin: { kind: 'person' },
      }, wide)).resolves.toEqual({ focused: true, element: 'run' })
      expect(ui.getSnapshot()[0]!.drawing).toBe(3)
    } finally {
      await ui.release(owner)
    }
  })

  test('person focus superseded by a no-op move finishes without a snapshot publication', async () => {
    const owner = { plugin: 'fixture' }
    let draws = 0
    const { ui } = fixture({
      draw: async () => {
        if (++draws === 2) return new Promise<never>(() => {})
        return { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }
      },
    })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    void ui.invalidate(owner, 'ui.render')
    const request = { requestId: 'pane', element: 'run', origin: { kind: 'person' as const } }
    let firstFinished = false
    let secondFinished = false
    const first = ui.focus(owner, request, wide).then(result => { firstFinished = true; return result })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(firstFinished).toBe(false)
      const before = ui.getSnapshot()
      const second = ui.focus(owner, request, wide).then(result => { secondFinished = true; return result })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(ui.getSnapshot()).toBe(before)
      expect(firstFinished).toBe(true)
      expect(secondFinished).toBe(false)
      await expect(first).resolves.toEqual({ focused: true, element: 'run' })
      await ui.focus(owner, { requestId: 'pane', origin: { kind: 'person' } }, wide)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(secondFinished).toBe(true)
      await expect(second).resolves.toEqual({ focused: false })
    } finally {
      await ui.release(owner)
    }
  })

  for (const rejection of ['before', 'after'] as const) {
    test(`person focus ignores an old draw rejecting ${rejection} the superseding draw succeeds`, async () => {
      const owner = { plugin: 'fixture' }
      const first = Promise.withResolvers<void>()
      const second = Promise.withResolvers<void>()
      const failure = new Error('obsolete draw failed')
      let draws = 0
      const { ui, released } = fixture({
        draw: async () => {
          if (++draws === 2) await first.promise
          else if (draws === 3) await second.promise
          return { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }
        },
      })
      await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
      await ui.commit(owner)
      const invalidating = ui.invalidate(owner, 'ui.render').catch(error => error)
      let finished = false
      const focusing = ui.focus(owner, {
        requestId: 'pane', element: 'run', origin: { kind: 'person' },
      }, wide).then(
        result => { finished = true; return { result } },
        error => { finished = true; return { error } },
      )
      let replacing: Promise<void> | undefined
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(finished).toBe(false)
        replacing = ui.invalidate(owner, 'ui.render')
        await new Promise<void>(resolve => setImmediate(resolve))
        if (rejection === 'before') {
          first.reject(failure)
          expect(await invalidating).toBe(failure)
        }
        expect(finished).toBe(false)
        second.resolve()
        await replacing
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(finished).toBe(true)
        await expect(focusing).resolves.toEqual({ result: { focused: true, element: 'run' } })
        const landed = ui.getSnapshot()
        expect(landed[0]!.drawing).toBe(3)
        if (rejection === 'after') first.reject(failure)
        expect(await invalidating).toBe(failure)
        expect(released).toContain(2)
        expect(ui.getSnapshot()).toBe(landed)
      } finally {
        first.resolve(); second.resolve()
        await Promise.all([focusing, invalidating, replacing])
        await ui.release(owner)
      }
    })
  }

  for (const cancellation of ['hidden', 'close', 'replacement', 'unload'] as const) {
    test(`person focus finishes on ${cancellation} before the pending draw rejects`, async () => {
      const owner = { plugin: 'fixture' }
      const nextOwner = { plugin: 'fixture' }
      const pending = Promise.withResolvers<void>()
      const failure = new Error('cancelled draw failed')
      let draws = 0
      const { ui, released } = fixture({
        draw: async () => {
          if (++draws === 2) await pending.promise
          return { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }
        },
      })
      await ui.open(owner, { id: 'pane', focus: true }, { kind: 'plugin' }, wide)
      await ui.commit(owner)
      const rendering = ui.render(wide).catch(error => error)
      let finished = false
      const focusing = ui.focus(owner, {
        requestId: 'pane', element: 'run', origin: { kind: 'person' },
      }, wide).then(
        result => { finished = true; return { result } },
        error => { finished = true; return { error } },
      )
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(finished).toBe(false)
        if (cancellation === 'hidden') await ui.render({ ...wide, columns: 100 })
        else if (cancellation === 'close') await ui.close(owner, 'pane', { kind: 'person' })
        else if (cancellation === 'unload') await ui.release(owner)
        else {
          await ui.open(nextOwner, { id: 'pane' }, { kind: 'plugin' }, wide)
          await ui.commit(nextOwner, owner)
        }
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(finished).toBe(true)
        await expect(focusing).resolves.toEqual({ result: { focused: false } })
        const landed = ui.getSnapshot()
        pending.reject(failure)
        expect(await rendering).toBe(failure)
        expect(released).toContain(2)
        expect(ui.getSnapshot()).toBe(landed)
      } finally {
        pending.resolve()
        await Promise.all([focusing, rendering])
        await ui.release(owner)
        await ui.release(nextOwner)
      }
    })
  }

  for (const cancellation of ['Escape', 'redraw'] as const) {
    test(`person focus ignores a queued draw rejection overtaken by ${cancellation}`, async () => {
      const owner = { plugin: 'fixture' }
      const pending = Promise.withResolvers<void>()
      const cleanup = Promise.withResolvers<void>()
      const failure = new Error('cancelled draw failed')
      let draws = 0
      const { ui } = fixture({
        draw: async () => {
          if (++draws === 2) await pending.promise
          return { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }
        },
        releaseDrawing: async (_owner, drawing) => {
          if (drawing === 2) cleanup.resolve()
        },
      })
      await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
      await ui.commit(owner)
      const invalidating = ui.invalidate(owner, 'ui.render').catch(error => error)
      const focusing = ui.focus(owner, {
        requestId: 'pane', element: 'run', origin: { kind: 'person' },
      }, wide).then(result => ({ result }), error => ({ error }))
      try {
        await new Promise<void>(resolve => setImmediate(resolve))
        pending.reject(failure)
        await cleanup.promise
        // Queue cancellation after drawing cleanup but before focus handles the rejection.
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        if (cancellation === 'Escape')
          await ui.focus(owner, { requestId: 'pane', origin: { kind: 'person' } }, wide)
        else await ui.invalidate(owner, 'ui.render')
        await expect(focusing).resolves.toEqual({ result: cancellation === 'Escape'
          ? { focused: false }
          : { focused: true, element: 'run' } })
        expect(await invalidating).toBe(failure)
      } finally {
        pending.resolve()
        await Promise.all([focusing, invalidating])
        await ui.release(owner)
      }
    })
  }

  test('person focus still rejects when its current draw fails', async () => {
    const owner = { plugin: 'fixture' }
    const pending = Promise.withResolvers<void>()
    const failure = new Error('current draw failed')
    let draws = 0
    const { ui, released } = fixture({
      draw: async () => {
        if (++draws === 2) await pending.promise
        return { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }
      },
    })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    const invalidating = ui.invalidate(owner, 'ui.render').catch(error => error)
    const focusing = ui.focus(owner, {
      requestId: 'pane', element: 'run', origin: { kind: 'person' },
    }, wide).then(result => ({ result }), error => ({ error }))
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      pending.reject(failure)
      await expect(focusing).resolves.toEqual({ error: failure })
      expect(await invalidating).toBe(failure)
      expect(released).toContain(2)
    } finally {
      pending.resolve()
      await Promise.all([focusing, invalidating])
      await ui.release(owner)
    }
  })

  test('person admission rechecks visibility and presentation after asynchronous focus middleware', async () => {
    const owner = { plugin: 'fixture' }
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const { ui } = fixture({
      dispatch: async (_owner, event, input, core) => {
        if (event === 'ui.focus') {
          entered.resolve()
          await proceed.promise
        }
        return core(input)
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    const focusing = ui.focus(owner, {
      requestId: 'pane', element: 'run', origin: { kind: 'person' },
    }, wide)
    await entered.promise
    await ui.render({ ...wide, hasDialog: true })
    proceed.resolve()
    await expect(focusing).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
    expect(ui.getSnapshot()[0]!.focused).toBe(false)
  })

  test('a delayed person focus move cannot reacquire the pane after Escape relinquishes it', async () => {
    const owner = { plugin: 'fixture' }
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    let delay = false
    const { ui } = fixture({
      dispatch: async (_owner, event, input, core) => {
        if (event === 'ui.focus' && input.element !== undefined && delay) {
          entered.resolve()
          await proceed.promise
        }
        return core(input)
      },
    })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    await ui.focus(owner, { requestId: 'pane', element: 'run', origin: { kind: 'person' } }, wide)
    delay = true
    const focusing = ui.focus(owner, {
      requestId: 'pane', element: 'run', origin: { kind: 'person' },
    }, wide)
    await entered.promise
    expect(await ui.focus(owner, { requestId: 'pane', origin: { kind: 'person' } }, wide))
      .toEqual({ focused: false })
    proceed.resolve()
    await expect(focusing).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
    expect(ui.getSnapshot()[0]!.focused).toBe(false)
    expect(ui.getSnapshot()[0]).not.toHaveProperty('focusedElement')
    delay = false
    await expect(ui.focus(owner, {
      requestId: 'pane', element: 'run', origin: { kind: 'person' },
    }, wide)).resolves.toEqual({ focused: true, element: 'run' })
  })

  test('a delayed person focus move cannot steal a later landing in another pane', async () => {
    const owner = { plugin: 'fixture' }
    const entered = Promise.withResolvers<void>()
    const proceed = Promise.withResolvers<void>()
    const { ui } = fixture({
      dispatch: async (_owner, event, input, core) => {
        if (event === 'ui.focus' && input.requestId === 'first') {
          entered.resolve()
          await proceed.promise
        }
        return core(input)
      },
    })
    await ui.open(owner, { id: 'first' }, { kind: 'plugin' }, wide)
    await ui.open(owner, { id: 'second' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    const focusing = ui.focus(owner, {
      requestId: 'first', element: 'run', origin: { kind: 'person' },
    }, wide)
    await entered.promise
    await expect(ui.focus(owner, {
      requestId: 'second', element: 'run', origin: { kind: 'person' },
    }, wide)).resolves.toEqual({ focused: true, element: 'run' })
    proceed.resolve()
    await expect(focusing).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
    expect(ui.getSnapshot().filter(pane => pane.focused).map(pane => pane.id)).toEqual(['second'])
  })

  test('returns the final landing after middleware makes a later focus move', async () => {
    const owner = { plugin: 'fixture' }
    const { ui } = fixture({
      dispatch: async (_owner, event, input, core) => {
        const result = await core(input)
        if (event === 'ui.focus' && input.element === 'run') {
          await ui.focus(owner, { requestId: 'pane', origin: { kind: 'person' } })
        }
        return result
      },
    })
    await ui.open(owner, { id: 'pane', focus: true }, { kind: 'person' }, wide)
    await ui.commit(owner)
    await expect(ui.focus(owner, {
      requestId: 'pane', element: 'run', origin: { kind: 'person' },
    })).resolves.toEqual({ focused: false })
  })

  test('scroll middleware can consume virtual-list wheel events without outer overflow or extra offset', async () => {
    const owner = { plugin: 'fixture' }
    const events: unknown[] = []
    const { ui } = fixture({
      dispatch: async (_owner, event, input, core) => {
        if (event !== 'ui.scroll') return core(input)
        events.push(input)
        return {}
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    await ui.reportMetrics('pane', { bodyRows: 4, contentRows: 4 })
    const snapshot = ui.getSnapshot()
    for (const by of [3, -3]) {
      await expect(ui.scroll(owner, {
        requestId: 'pane', by, pointer: { column: 2, row: 1 }, origin: { kind: 'person' },
      })).resolves.toEqual({})
    }
    expect(events).toEqual([3, -3].map(by => ({
      component: 'Pane', requestId: 'pane', offset: 0, by, bodyRows: 4, contentRows: 4,
      origin: { kind: 'person' }, pointer: { column: 2, row: 1 },
    })))
    expect(ui.getSnapshot()).toBe(snapshot)
    expect(ui.getSnapshot()[0]).toMatchObject({ focused: false, scrollOffset: 0 })
  })

  test('accepts pointer coordinates preserved across a Worker copy but rejects coordinate rewrites', async () => {
    const owner = { plugin: 'fixture' }
    let rewrite = false
    const { ui } = fixture({
      dispatch: async (_owner, event, input, core) => {
        if (event !== 'ui.scroll') return core(input)
        const copied = structuredClone(input)
        if (rewrite) copied.pointer = { column: 3, row: 1 }
        return core(copied)
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    await ui.reportMetrics('pane', { bodyRows: 4, contentRows: 12 })
    await expect(ui.scroll(owner, {
      requestId: 'pane', by: 3, pointer: { column: 2, row: 1 }, origin: { kind: 'person' },
    })).resolves.toEqual({})
    expect(ui.getSnapshot()[0]!.scrollOffset).toBe(3)
    rewrite = true
    await expect(ui.scroll(owner, {
      requestId: 'pane', by: 3, pointer: { column: 2, row: 1 }, origin: { kind: 'person' },
    })).rejects.toThrow(/rewrite pointer/)
    expect(ui.getSnapshot()[0]!.scrollOffset).toBe(3)
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
    await ui.reportMetrics('pane', { bodyRows: 4, contentRows: 12 })

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
    await ui.reportMetrics('pane', {
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
    await ui.reportMetrics('pane', { bodyRows: current.bodyRows, contentRows: current.contentRows })
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

  test('redraws measured body heights, preserves them on focus and resets them on geometry changes', async () => {
    const owner = {}
    const { ui, draws, released } = fixture()
    await ui.open(owner, { id: 'pane', rows: 7 }, { kind: 'person' }, wide)
    await ui.commit(owner)
    const original = ui.getSnapshot()[0]!.drawing!
    await ui.reportMetrics('pane', { bodyRows: 31, contentRows: 60 })
    expect(draws).toHaveLength(2)
    expect(draws.at(-1)!.input.props).toMatchObject({ scroll: { bodyRows: 31 } })
    expect(released).toContain(original)
    await ui.reportMetrics('pane', { bodyRows: 31, contentRows: 60 })
    await ui.reportMetrics('pane', { bodyRows: 31, contentRows: 61 })
    expect(draws).toHaveLength(2)
    await ui.focus(owner, { requestId: 'pane', element: 'run', origin: { kind: 'person' } }, wide)
    expect(ui.getSnapshot()[0]!.bodyRows).toBe(31)
    await ui.render({ ...wide, hasDialog: true })
    expect(draws.at(-1)!.input.props).toMatchObject({ scroll: { bodyRows: 31 } })
    await ui.render({ ...wide, columns: 109 })
    expect(ui.getSnapshot()[0]).toMatchObject({ placement: 'inline', bodyRows: 7 })
    await ui.render(wide)
    expect(ui.getSnapshot()[0]).toMatchObject({ placement: 'dock', bodyRows: 36 })
    await ui.reportMetrics('pane', { bodyRows: 33, contentRows: 60 })
    expect(draws.at(-1)!.input.props).toMatchObject({ scroll: { bodyRows: 33 } })
    await ui.release(owner)
  })

  test('rejects a failed metrics redraw without dropping the current drawing and recovers on invalidate', async () => {
    const owner = {}
    let fail = false
    const { ui, released } = fixture({
      draw: async () => {
        if (fail) throw new Error('height draw failed')
        return { type: 'Text', children: ['body'] }
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide)
    await ui.commit(owner)
    const original = ui.getSnapshot()[0]!.drawing!
    fail = true
    await expect(ui.reportMetrics('pane', { bodyRows: 31, contentRows: 60 })).rejects.toThrow('height draw failed')
    expect(ui.getSnapshot()[0]).toMatchObject({ drawing: original, bodyRows: 31 })
    expect(released).not.toContain(original)
    expect(released).toHaveLength(1)
    fail = false
    await ui.invalidate(owner, 'ui.render')
    expect(ui.getSnapshot()[0]!.drawing).not.toBe(original)
    expect(released).toContain(original)
    await ui.release(owner)
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

    const older = ui.render(wide)
    const newer = ui.render(wide)
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
test('pending blits cannot mutate a released pane or its replacement', async () => {
  const owner = { plugin: 'fixture' }
  const replacement = { plugin: 'fixture' }
  const gate = Promise.withResolvers<void>()
  const { ui } = fixture({
    dispatch: async (_owner, event, input, core) => {
      if (event === 'ui.blit') await gate.promise
      return core(input)
    },
    draw: async () => ({type:'Raster',props:{key:'pixels',cells:'old',columns:1,rows:1},group:{plugin:'fixture'}}),
  })
  await ui.open(owner, {id:'pane'}, {kind:'person'}, wide)
  await ui.commit(owner)
  const pending = ui.blit(owner, {requestId:'pane',key:'pixels',cells:'new'})
  await ui.release(owner)
  await ui.open(replacement, {id:'pane'}, {kind:'person'}, wide)
  await ui.commit(replacement)
  gate.resolve()
  expect(await pending).toEqual({deny:'site is no longer mounted'})
  expect((ui.getSnapshot()[0]!.tree as {props:{cells:string}}).props.cells).toBe('old')
})

test('blit validates the replacement tree before publication', async () => {
  const owner = { plugin: 'fixture' }
  const { ui } = fixture({
    draw: async () => ({type:'Raster',props:{key:'pixels',cells:'old',columns:1,rows:1},group:{plugin:'fixture'}}),
    validateTree: tree => {
      if ((tree as {props:{cells:string}}).props.cells === 'invalid') throw new TypeError('invalid cells')
    },
  })
  await ui.open(owner, {id:'pane'}, {kind:'person'}, wide)
  await ui.commit(owner)
  const before = ui.getSnapshot()[0]
  await expect(ui.blit(owner, {requestId:'pane',key:'pixels',cells:'invalid'})).rejects.toThrow('invalid cells')
  expect(ui.getSnapshot()[0]).toBe(before)
})

  test('folds burst invalidations into one redraw and releases its replaced drawing', async () => {
    const owner = { plugin: 'fixture' }
    const resolvers: ((tree: unknown) => void)[] = []
    const { ui, released } = fixture({
      draw: async () => new Promise(resolve => resolvers.push(resolve)),
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    const committing = ui.commit(owner)
    resolvers.shift()!({ type: 'Text', children: ['first'] })
    await committing
    const first = ui.getSnapshot()[0]!.drawing

    const invalidations = [
      ui.invalidate(owner, 'ui.render'),
      ui.invalidate(owner, 'ui.render'),
      ui.invalidate(owner, 'ui.render'),
    ]
    await Promise.resolve()
    expect(resolvers).toHaveLength(1)
    await Bun.sleep(35)
    resolvers.shift()!({ type: 'Text', children: ['next'] })
    await Promise.all(invalidations)

    expect(ui.getSnapshot()[0]!.tree).toEqual({ type: 'Text', children: ['next'] })
    expect(released).toContain(first)
  })


  test('merges invalidations from different plugins and keeps one trailing redraw', async () => {
    const owner = { plugin: 'fixture' }
    const other = { plugin: 'other' }
    const resolvers: ((tree: unknown) => void)[] = []
    const { ui } = fixture({
      draw: async () => new Promise(resolve => resolvers.push(resolve)),
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    const committing = ui.commit(owner)
    resolvers.shift()!({ type: 'Text', children: ['first'] })
    await committing
    await ui.commit(other)

    const first = ui.invalidate(owner, 'ui.render')
    await Promise.resolve()
    expect(resolvers).toHaveLength(1)
    const trailing = ui.invalidate(other, 'ui.render')
    await Promise.resolve()
    expect(resolvers).toHaveLength(1)

    resolvers.shift()!({ type: 'Text', children: ['second'] })
    await first
    await Bun.sleep(40)
    expect(resolvers).toHaveLength(1)
    resolvers.shift()!({ type: 'Text', children: ['third'] })
    await trailing

    expect(ui.getSnapshot()[0]!.tree).toEqual({ type: 'Text', children: ['third'] })
  })


  test('rate limits sequential invalidations without waiting for an obsolete draw', async () => {
    const owner = { plugin: 'fixture' }
    const pending = Promise.withResolvers<unknown>()
    const starts: number[] = []
    const { ui, released } = fixture({
      draw: async () => {
        starts.push(performance.now())
        if (starts.length === 2) return pending.promise
        return { type: 'Text', children: [String(starts.length)] }
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'person' }, wide)
    await ui.commit(owner)
    const first = ui.invalidate(owner, 'ui.render')
    await Promise.resolve()
    try {
      await ui.invalidate(owner, 'ui.render')
      expect(starts).toHaveLength(3)
      expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(30)
      expect(ui.getSnapshot()[0]!.tree).toEqual({ type: 'Text', children: ['3'] })
    } finally {
      pending.resolve({ type: 'Text', children: ['obsolete'] })
      await first
      await ui.release(owner)
    }
    expect(released).toContain(2)
  })

  test('does not draw a queued invalidation after its pane closes', async () => {
    const owner = { plugin: 'fixture' }
    const draws: number[] = []
    const { ui } = fixture({
      draw: async (_owner, _input, drawing) => {
        draws.push(drawing)
        return { type: 'Text', children: [String(drawing)] }
      },
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'plugin' }, wide)
    await ui.commit(owner)
    await ui.invalidate(owner, 'ui.render')
    await Bun.sleep(1)

    const queued = ui.invalidate(owner, 'ui.render')
    await ui.close(owner, 'pane', { kind: 'unload' })
    await queued
    await Bun.sleep(40)

    expect(draws).toHaveLength(2)
    expect(ui.getSnapshot()).toEqual([])
  })
