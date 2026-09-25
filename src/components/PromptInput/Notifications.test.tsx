import assert from 'node:assert/strict'
import * as React from 'react'

import { Text } from '../../ink.js'
import { GoalStatusIndicator } from './goalStatusIndicator.js'

const inactive = GoalStatusIndicator({ active: false })
assert.equal(inactive, null)

const active = GoalStatusIndicator({ active: true })
assert.ok(React.isValidElement(active))
assert.equal(active.type, Text)
assert.deepEqual(active.props, {
  color: 'ansi:magentaBright',
  bold: true,
  children: 'Goal is set',
})

const { createModUi } = await import('../../services/mods/ui.js')
const { shouldHoldToasts, getVisibleTransientNotification } = await import('./Notifications.js')
const { test } = await import('bun:test')

const transient = { key: 'transient', text: 'Transient notice', priority: 'low' as const }
const wide = { columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }
function paneFixture() {
  const owner = {}
  const ui = createModUi({
    pluginOf: () => 'fixture',
    dispatch: async (_owner, _event, input, core) => core(input),
    draw: async () => ({ type: 'Text', props: { children: 'Pane' } }),
    invokeDrawing: async () => undefined,
    releaseDrawing: async () => {},
  })
  const shownToast = () => getVisibleTransientNotification(transient, shouldHoldToasts(ui.getSnapshot()))
  return { owner, ui, shownToast }
}

test('shown pane holds toast; hidden pane and close restore unchanged toast', async () => {
  const { owner, ui, shownToast } = paneFixture()
  await ui.open(owner, { id: 'hold', holdToasts: true }, { kind: 'plugin' }, wide)
  await ui.commit(owner)
  assert.equal(ui.getSnapshot()[0]!.shown, true)
  assert.equal(shownToast(), null)
  await ui.render({ ...wide, columns: 80 })
  assert.equal(ui.getSnapshot()[0]!.visible, false)
  assert.equal(shownToast(), transient)
  await ui.render(wide)
  assert.equal(shownToast(), null)
  await ui.close(owner, 'hold', { kind: 'person' })
  assert.equal(shownToast(), transient)
})

test('tab switching considers only shown pane and restores after last holding pane closes', async () => {
  const { owner, ui, shownToast } = paneFixture()
  await ui.open(owner, { id: 'hold', holdToasts: true }, { kind: 'person' }, wide)
  await ui.commit(owner)
  await ui.open(owner, { id: 'plain' }, { kind: 'person' }, wide)
  await ui.focus(owner, { requestId: 'plain', origin: { kind: 'person' } })
  assert.equal(ui.getSnapshot().find(p => p.id === 'hold')!.shown, false)
  assert.equal(shownToast(), transient)
  await ui.focus(owner, { requestId: 'hold', origin: { kind: 'person' } })
  assert.equal(shownToast(), null)
  await ui.open(owner, { id: 'hold2', holdToasts: true }, { kind: 'person' }, wide)
  await ui.focus(owner, { requestId: 'hold2', origin: { kind: 'person' } })
  assert.equal(shownToast(), null)
  await ui.close(owner, 'hold2', { kind: 'person' })
  assert.equal(shownToast(), null)
  await ui.close(owner, 'hold', { kind: 'person' })
  assert.equal(shownToast(), transient)
  assert.equal(ui.getSnapshot()[0]!.id, 'plain')
})

console.log('Notifications.test.tsx passed')
