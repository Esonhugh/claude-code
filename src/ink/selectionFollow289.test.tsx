import { expect, test } from 'bun:test'
import React, { createRef } from 'react'
import { Writable } from 'node:stream'
import { Box, Text, render } from '../ink.js'
import instances from './instances.js'
import ScrollBox, { type ScrollBoxHandle } from './components/ScrollBox.js'
import {
  createSelectionState,
  startSelection,
  updateSelection,
  finishSelection,
  shiftSelection,
  captureScrolledRows,
  getSelectedText,
  applySelectionOverlay,
  hasSelection,
} from './selection.js'
import {
  CharPool,
  StylePool,
  HyperlinkPool,
  createScreen,
  setCellAt,
  cellAt,
  CellWidth,
} from './screen.js'
import { Tg } from './fixtures/official-289-selection.js'
import type { Frame } from './frame.js'

function screen(lines: string[]) {
  const styles = new StylePool(),
    data = createScreen(
      12,
      lines.length,
      styles,
      new CharPool(),
      new HyperlinkPool(),
    )
  for (const [row, line] of lines.entries())
    for (const [col, char] of [...line].entries())
      setCellAt(data, col, row, {
        char,
        styleId: data.emptyStyleId,
        hyperlink: undefined,
        width: CellWidth.Narrow,
      })
  return { data, styles }
}
function selected() {
  const s = createSelectionState()
  startSelection(s, 2, 0)
  updateSelection(s, 3, 1)
  finishSelection(s)
  return s
}
test('selection shifting matches the genuine289 Tg for bidirectional, fully hidden and cross-edge jumps', () => {
  for (const moves of [
    [-1, 1],
    [-4, 4],
    [6, -6],
    [-20, 30, -10],
    [20, -30, 10],
  ]) {
    const local = selected(),
      official = structuredClone(local)
    for (const delta of moves) {
      shiftSelection(local, delta, 0, 3, 12)
      Tg(official, delta, 0, 3, 12)
      expect(local).toEqual(official)
    }
  }
})
test('fully hidden text remains copyable without painting or copying the clamped corner', () => {
  const { data, styles } = screen(['corner', 'wrong', 'other', 'noise'])
  const s = selected()
  Object.assign(s, {
    anchor: { col: 0, row: 0 },
    focus: { col: 0, row: 0 },
    virtualAnchorRow: -4,
    virtualFocusRow: -3,
    scrolledOffAbove: ['kept first', 'kept last'],
    scrolledOffAboveSW: [false, false],
  })
  expect(hasSelection(s)).toBe(true)
  expect(getSelectedText(s, data)).toBe('kept first\nkept last')
  const style = cellAt(data, 0, 0)!.styleId
  applySelectionOverlay(data, s, styles)
  expect(cellAt(data, 0, 0)!.styleId).toBe(style)
})
test('capture then scroll roundtrip restores the original endpoint columns and drops copied rows', () => {
  const { data } = screen(['alphaAAA', 'betaBBBB', 'newCCC', 'otherDDD'])
  const s = selected()
  captureScrolledRows(s, data, 0, 3, 'above')
  shiftSelection(s, -4, 0, 3, 12)
  expect(hasSelection(s)).toBe(true)
  expect(getSelectedText(s, data)).toBe('phaAAA\nbeta')
  shiftSelection(s, 4, 0, 3, 12)
  expect(s.anchor).toEqual({ col: 2, row: 0 })
  expect(s.focus).toEqual({ col: 3, row: 1 })
  expect(s.scrolledOffAbove).toEqual([])
  expect(getSelectedText(s, data)).toBe('phaAAA\nbeta')
})
test('one jump from fully below to fully above transfers its bounded captured text', () => {
  const s = selected()
  Object.assign(s, {
    anchor: { col: 11, row: 3 },
    focus: { col: 11, row: 3 },
    virtualAnchorRow: 8,
    virtualFocusRow: 9,
    virtualAnchorCol: 2,
    virtualFocusCol: 3,
    scrolledOffBelow: ['first', 'last'],
    scrolledOffBelowSW: [false, true],
  })
  const official = structuredClone(s)
  Tg(official, -12, 0, 3, 12)
  shiftSelection(s, -12, 0, 3, 12)
  expect(s).toEqual(official)
  expect(s.scrolledOffAbove).toEqual(['first', 'last'])
  expect(s.scrolledOffBelow).toEqual([])
})
class Output extends Writable {
  columns = 40
  rows = 8
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 55))
}
async function scene() {
  const output = new Output(),
    stdout = output as unknown as NodeJS.WriteStream,
    left = createRef<ScrollBoxHandle>(),
    right = createRef<ScrollBoxHandle>(),
    frames: Frame[] = []
  const rows = (prefix: string) =>
    Array.from({ length: 12 }, (_, i) => (
      <Text key={i}>{prefix + i.toString().padStart(2, '0')}</Text>
    ))
  const node = (
    <Box width={40} height={8} flexDirection="row">
      <ScrollBox ref={left} width={20} height={4} flexDirection="column">
        {rows('left-')}
      </ScrollBox>
      <ScrollBox ref={right} width={20} height={4} flexDirection="column">
        {rows('right-')}
      </ScrollBox>
    </Box>
  )
  const rendered = await render(node, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
      onFrame: (e) => {
        if (e.frame) frames.push(e.frame)
      },
    }),
    ink = instances.get(stdout)!
  ink.setAltScreenActive(true)
  rendered.rerender(node)
  await settle()
  frames.length = 0
  return { ink, rendered, left: left.current!, right: right.current!, frames }
}
test('actual Ink scrollTo keeps hidden selection text, restores on reverse and owns signed delta per frame', async () => {
  const v = await scene()
  try {
    v.ink.startTextSelection(0, 1)
    updateSelection(v.ink.selection, 6, 1)
    finishSelection(v.ink.selection)
    expect(v.ink.getSelectedText()).toBe('left-01')
    v.left.scrollTo(4)
    await settle()
    expect(v.ink.hasTextSelection()).toBe(true)
    expect(v.ink.getSelectedText()).toBe('left-01')
    expect(v.ink.selection.virtualAnchorRow).toBe(-3)
    v.left.scrollTo(0)
    await settle()
    expect(v.ink.selection.anchor).toEqual({ col: 0, row: 1 })
    expect(v.ink.selection.focus).toEqual({ col: 6, row: 1 })
    expect(v.ink.getSelectedText()).toBe('left-01')
    const events = v.frames
      .map(
        (frame) =>
          (
            frame as Frame & {
              followScroll?: {
                delta: number
                viewportLeft: number
                viewportRight: number
              }
            }
          ).followScroll,
      )
      .filter(Boolean)
    expect(events.map((e) => e!.delta)).toEqual([4, -4])
    expect(
      events.every((e) => e!.viewportLeft === 0 && e!.viewportRight === 19),
    ).toBe(true)
  } finally {
    v.rendered.unmount()
  }
})
test('actual Ink sticky scroll in an adjacent column does not move or capture another scope', async () => {
  const v = await scene()
  try {
    v.ink.startTextSelection(20, 1)
    updateSelection(v.ink.selection, 27, 1)
    finishSelection(v.ink.selection)
    const before = structuredClone({ ...v.ink.selection, scope: undefined }),
      text = v.ink.getSelectedText()
    expect(text).toBe('right-01')
    v.left.scrollToBottom()
    await settle()
    expect(v.ink.getSelectedText()).toBe(text)
    expect({ ...v.ink.selection, scope: undefined }).toEqual(before)
  } finally {
    v.rendered.unmount()
  }
})
test('actual virtual clamp and pending drain use painted movement without stale or duplicate frame deltas', async () => {
  const v = await scene()
  try {
    v.ink.startTextSelection(0, 1)
    updateSelection(v.ink.selection, 6, 1)
    finishSelection(v.ink.selection)
    v.left.setClampBounds(0, 2)
    v.left.scrollTo(8)
    await settle()
    expect(v.left.getElement()!.scrollTopRendered).toBe(2)
    expect(v.ink.getSelectedText()).toBe('left-01')
    v.left.setClampBounds(0, 8)
    v.left.scrollTo(8)
    await settle()
    expect(v.ink.getSelectedText()).toBe('left-01')
    v.left.scrollBy(-3)
    await settle()
    expect(v.ink.getSelectedText()).toBe('left-01')
    const events = v.frames
      .map(
        (frame) =>
          (frame as Frame & { followScroll?: { delta: number } }).followScroll,
      )
      .filter(Boolean)
    expect(events.slice(0, 2).map((e) => e!.delta)).toEqual([2, 6])
    expect(events.slice(2).reduce((sum, e) => sum + e!.delta, 0)).toBe(-3)
  } finally {
    v.rendered.unmount()
  }
})
