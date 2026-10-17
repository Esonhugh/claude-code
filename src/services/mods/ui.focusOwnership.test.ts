import { expect, test } from 'bun:test'
import { createModUi, didModUiHostFocusMove, withModUiHostFocusOutcome, type ModUiDispatch, type ModUiFocusTarget, type ModUiPresentation } from './ui.js'

const draft: ModUiPresentation = {
  columns: 160, rows: 40, isFullscreen: true, composerEmpty: false,
  composerValue: 'retained draft', hasDialog: false, keyboardOwned: false,
}
function fixture(dispatch: ModUiDispatch = async (_owner, _event, input, core) => core(input)) {
  return createModUi({
    pluginOf: () => 'fixture', dispatch,
    draw: async () => ({ type: 'Button', props: { key: 'run', label: 'Run', autoFocus: true }, press: { plugin: 'fixture', handle: 1 } }),
    invokeDrawing: async () => undefined, releaseDrawing: async () => {},
  })
}

test('a changed held composer fences a suspended person focus even when the new draft is empty', async () => {
  const owner = {}
  const entered = Promise.withResolvers<void>()
  const proceed = Promise.withResolvers<void>()
  const ui = fixture(async (_owner, event, input, core) => {
    if (event === 'ui.focus') { entered.resolve(); await proceed.promise }
    return core(input)
  })
  await ui.open(owner, { id: 'pane' }, { kind: 'person' }, draft)
  await ui.commit(owner)
  expect(ui.cyclePaneFocus(draft.composerValue)).toBe(true)
  expect(ui.getSnapshot()[0]?.focused).toBe(true)
  const pending = ui.focus(owner, { requestId: 'pane', element: 'run', origin: { kind: 'person' } }, draft)
  try {
    await entered.promise
    await ui.render({ ...draft, composerEmpty: true, composerValue: '' })
    expect(ui.getSnapshot()[0]?.focused).toBe(false)
    proceed.resolve()
    await expect(pending).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
    expect(ui.getSnapshot()[0]?.focused).toBe(false)
    expect(ui.getSnapshot()[0]?.focusedElement).toBeUndefined()
  } finally { proceed.resolve(); await pending; await ui.release(owner) }
})

test('automatic first control honors an explicit canonical hold with a retained nonempty draft', async () => {
  const owner = {}
  const ui = fixture()
  await ui.open(owner, { id: 'pane' }, { kind: 'person' }, draft)
  await ui.commit(owner)
  try {
    const request = { requestId: 'pane', element: 'run', origin: { kind: 'plugin' as const, name: 'fixture' } }
    const options = { signal: new AbortController().signal, expectedElement: undefined }
    await expect(ui.focusHost(owner, request, draft, options)).resolves.toMatchObject({ focused: false, deny: expect.any(String) })
    expect(ui.cyclePaneFocus(draft.composerValue)).toBe(true)
    await expect(ui.focusHost(owner, request, draft, options)).resolves.toMatchObject({ focused: true, element: 'run', plugin: 'fixture' })
    expect(ui.getSnapshot()[0]).toMatchObject({ focused: true, focusedElement: 'run', focusedPlugin: 'fixture' })
    await ui.render({ ...draft, composerValue: 'changed draft' })
    expect(ui.getSnapshot()[0]?.focused).toBe(false)
    expect(ui.getSnapshot()[0]?.focusedElement).toBeUndefined()
  } finally { await ui.release(owner) }
})

test('host focus distinguishes accepted and withheld unchanged coordinates without adding author DTO fields', async () => {
  let withheld = false
  let holder: ModUiFocusTarget | undefined
  let commits = 0
  const ui = fixture(async (_owner, event, input, core) =>
    event === 'ui.focus' && withheld ? {} : core(input))
  const site = await ui.mount({ surface: 'terminal', component: 'AbovePrompt', requestId: 'band', props: {} }, {
    surface: 'terminal', render() {}, unmount() {},
    focus: {
      isHeldNow: () => true,
      holderNow: () => holder,
      hasElement: (plugin, element) => plugin === 'fixture' && element === 'run',
      commit: target => { commits++; holder = target },
    },
  })
  const request = { plugin: 'fixture', element: 'run', origin: { kind: 'person' as const } }
  try {
    const first = await site.focus(request)
    expect(didModUiHostFocusMove(first)).toBe(true)
    const second = await site.focus(request)
    expect(didModUiHostFocusMove(second)).toBe(true)
    expect(commits).toBe(2)
    withheld = true
    const retained = holder
    const blocked = await site.focus(request)
    expect(blocked).toEqual(second)
    expect(holder).toBe(retained)
    expect(commits).toBe(2)
    expect(didModUiHostFocusMove(blocked)).toBe(false)
    const copied = withModUiHostFocusOutcome(blocked, { ...blocked as object })
    expect(didModUiHostFocusMove(copied)).toBe(false)
    expect(Object.getOwnPropertySymbols(copied)).toEqual([])
    expect(JSON.parse(JSON.stringify(copied))).toEqual({ focused: true, element: 'run', plugin: 'fixture' })
    expect(didModUiHostFocusMove(structuredClone(copied))).toBeUndefined()
  } finally { await site.dispose() }
})
