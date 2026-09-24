import { expect, test } from 'bun:test'
import App, { handleMouseEvent } from './App.js'
import { EventEmitter } from '../events/emitter.js'
import type { PointerEvent } from '../events/pointer-event.js'
import type { ParsedMouse } from '../parse-keypress.js'
import {
  createSelectionState,
  startSelection,
  updateSelection,
} from '../selection.js'

function mouse(
  action: ParsedMouse['action'],
  button: number,
  col: number,
  row: number,
): ParsedMouse {
  return {
    kind: 'mouse',
    action,
    button,
    col,
    row,
    sequence: `mouse:${action}:${button}:${col}:${row}`,
  }
}

function createApp() {
  const selection = createSelectionState()
  const calls = {
    selectionChanges: 0,
    clicks: 0,
    drags: [] as Array<[number, number]>,
    hovers: [] as Array<[number, number]>,
    multiClicks: [] as Array<[number, number, 2 | 3]>,
  }
  const app = {
    props: {
      selection,
      onSelectionChange: () => calls.selectionChanges++,
      onClickAt: () => {
        calls.clicks++
        return false
      },
      onHoverAt: (col: number, row: number) => calls.hovers.push([col, row]),
      getHyperlinkAt: () => undefined,
      onOpenHyperlink: () => {},
      onMultiClick: (col: number, row: number, count: 2 | 3) =>
        calls.multiClicks.push([col, row, count]),
      onSelectionDrag: (col: number, row: number) => {
        calls.drags.push([col, row])
        updateSelection(selection, col, row)
      },
    },
    internal_eventEmitter: new EventEmitter(),
    lastClickTime: 0,
    lastClickCol: -1,
    lastClickRow: -1,
    clickCount: 0,
    pendingHyperlinkTimer: null,
    lastHoverCol: -1,
    lastHoverRow: -1,
  } as unknown as App

  return { app, selection, calls }
}

test('consumed pointer down, move, and up bypass selection and click handling', () => {
  const { app, selection, calls } = createApp()
  startSelection(selection, 8, 9)
  const selectionBefore = structuredClone(selection)
  const inputs = [
    mouse('press', 0x04 | 0x08 | 0x10, 3, 5),
    mouse('press', 0x20, 6, 7),
    mouse('release', 0, 6, 7),
  ]
  const events: PointerEvent[] = []

  app.internal_eventEmitter.on('pointer', (event: PointerEvent) => {
    events.push(event)
    event.stopImmediatePropagation()
  })

  for (const input of inputs) handleMouseEvent(app, input)

  expect(selection).toEqual(selectionBefore)
  expect(calls).toEqual({
    selectionChanges: 0,
    clicks: 0,
    drags: [],
    hovers: [],
    multiClicks: [],
  })
  expect(app.clickCount).toBe(0)
  expect(events).toHaveLength(3)
  expect(
    events.map(event => ({
      parsed: event.parsed,
      type: event.type,
      col: event.col,
      row: event.row,
      button: event.button,
      shift: event.shift,
      alt: event.alt,
      ctrl: event.ctrl,
    })),
  ).toEqual([
    {
      parsed: inputs[0],
      type: 'down',
      col: 2,
      row: 4,
      button: 0,
      shift: true,
      alt: true,
      ctrl: true,
    },
    {
      parsed: inputs[1],
      type: 'move',
      col: 5,
      row: 6,
      button: 0,
      shift: false,
      alt: false,
      ctrl: false,
    },
    {
      parsed: inputs[2],
      type: 'up',
      col: 5,
      row: 6,
      button: 0,
      shift: false,
      alt: false,
      ctrl: false,
    },
  ])
})

test('unconsumed pointer events preserve existing selection behavior', () => {
  const { app, selection, calls } = createApp()
  const inputs = [
    mouse('press', 0, 3, 5),
    mouse('press', 0x20, 6, 7),
    mouse('release', 0, 6, 7),
  ]
  const events: PointerEvent[] = []
  app.internal_eventEmitter.on('pointer', (event: PointerEvent) => {
    events.push(event)
  })

  for (const input of inputs) handleMouseEvent(app, input)

  expect(events.map(event => event.type)).toEqual(['down', 'move', 'up'])
  expect(selection.anchor).toEqual({ col: 2, row: 4 })
  expect(selection.focus).toEqual({ col: 5, row: 6 })
  expect(selection.isDragging).toBe(false)
  expect(calls.drags).toEqual([[5, 6]])
  expect(calls.selectionChanges).toBe(2)
  expect(calls.clicks).toBe(0)
})

test('no pointer subscriber preserves existing click handling', () => {
  const { app, selection, calls } = createApp()

  handleMouseEvent(app, mouse('press', 0, 3, 5))
  handleMouseEvent(app, mouse('release', 0, 3, 5))

  expect(selection.anchor).toEqual({ col: 2, row: 4 })
  expect(selection.focus).toBeNull()
  expect(selection.isDragging).toBe(false)
  expect(calls.clicks).toBe(1)
  expect(calls.selectionChanges).toBe(2)
})
