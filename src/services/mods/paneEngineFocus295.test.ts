import { expect, test } from 'bun:test'
import { createModUi, didModUiHostFocusMove, type ModUiDispatch } from './ui.js'

const presentation = { columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }
async function fixture(dispatch?: ModUiDispatch) {
  const owner = {}, seen: unknown[] = []
  const ui = createModUi({
    pluginOf: () => 'engine-test',
    dispatch: dispatch ?? (async (_owner, event, input, core) => {
      if (event === 'ui.focus') seen.push(input)
      return core(input)
    }),
    draw: async () => ({ type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'engine-test', handle: 1 } }),
    invokeDrawing: async () => {}, releaseDrawing: async () => {},
  })
  await ui.open(owner, { id: 'engine', focus: true }, { kind: 'person' }, presentation)
  await ui.commit(owner)
  await ui.focusPerson(owner, { requestId: 'engine', element: 'run' }, 'engine-test', presentation)
  return { ui, owner, seen }
}

test('trusted engine focus retains the Pane keyboard holder without changing public undefined focus', async () => {
  const { ui, owner, seen } = await fixture()
  try {
    const result = await ui.focusHost(owner, { requestId: 'engine', origin: { kind: 'person' } }, presentation, { engine: true })
    expect(result).toMatchObject({ focused: true })
    expect(didModUiHostFocusMove(result)).toBe(true)
    expect(ui.getSnapshot()[0]!.focused).toBe(true)
    expect(ui.getSnapshot()[0]!.focusedElement).toBeUndefined()
    expect(ui.getSnapshot()[0]!.focusedPlugin).toBeUndefined()
    expect(seen.at(-1)).toEqual({ component: 'Pane', requestId: 'engine', origin: { kind: 'person' } })
    expect(await ui.focus(owner, { requestId: 'engine', origin: { kind: 'person' } }, presentation)).toEqual({ focused: false })
    expect(ui.getSnapshot()[0]!.focused).toBe(false)
  } finally { await ui.dispose() }
})

for (const policy of ['deny', 'withhold'] as const) test('trusted engine ' + policy + ' keeps the actual control and rejects forged success', async () => {
  const { ui, owner } = await fixture(async (_owner, event, input, core) => {
    if (event === 'ui.focus' && input.element === undefined)
      return policy === 'deny' ? { deny: 'held' } : { focused: true }
    return core(input)
  })
  try {
    const result = await ui.focusHost(owner, { requestId: 'engine', origin: { kind: 'person' } }, presentation, { engine: true })
    expect(didModUiHostFocusMove(result)).toBe(false)
    expect(ui.getSnapshot()[0]).toMatchObject({ focused: true, focusedElement: 'run' })
  } finally { await ui.dispose() }
})

test('a delayed engine move cannot overwrite a newer person move', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const { ui, owner } = await fixture(async (_owner, event, input, core) => {
    if (event === 'ui.focus' && input.element === undefined) { entered.resolve(); await release.promise }
    return core(input)
  })
  try {
    const pending = ui.focusHost(owner, { requestId: 'engine', origin: { kind: 'person' } }, presentation, { engine: true })
    await entered.promise
    await ui.focusPerson(owner, { requestId: 'engine', element: 'run' }, 'engine-test', presentation)
    release.resolve()
    const result = await pending
    expect(result).toMatchObject({ deny: 'another move landed first', focused: true, element: 'run' })
    expect(didModUiHostFocusMove(result)).toBe(false)
    expect(ui.getSnapshot()[0]).toMatchObject({ focused: true, focusedElement: 'run' })
  } finally { release.resolve(); await ui.dispose() }
})

test('trusted engine move respects abort, current owner, and composer ownership', async () => {
  const { ui, owner } = await fixture()
  try {
    const controller = new AbortController(); controller.abort('abandoned')
    await expect(ui.focusHost(owner, { requestId: 'engine', origin: { kind: 'person' } }, presentation, {
      engine: true, signal: controller.signal,
    })).resolves.toMatchObject({ deny: 'the move was abandoned' })
    await expect(ui.focusHost({}, { requestId: 'engine', origin: { kind: 'person' } }, presentation, { engine: true }))
      .resolves.toMatchObject({ deny: 'site is not current', focused: false })
    await expect(ui.focusHost(owner, { requestId: 'engine', origin: { kind: 'person' } }, {
      ...presentation, keyboardOwned: true,
    }, { engine: true })).resolves.toMatchObject({ deny: 'site does not hold the keyboard', focused: false })
  } finally { await ui.dispose() }
})
