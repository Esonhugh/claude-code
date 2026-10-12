import { expect, test } from 'bun:test'
import React from 'react'
import { Writable } from 'node:stream'
import { Box, Text, render } from '../ink.js'
import instances from './instances.js'
import { finishSelection } from './selection.js'
class Output extends Writable {
  columns = 40
  rows = 8
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}
async function scene(node: React.ReactNode) {
  const stdout = new Output() as unknown as NodeJS.WriteStream,
    rendered = await render(node, {
      stdout,
      patchConsole: false,
      exitOnCtrlC: false,
    }),
    ink = instances.get(stdout)!
  ink.setAltScreenActive(true)
  rendered.rerender(node)
  await new Promise((resolve) => setTimeout(resolve, 50))
  return { ink, close: () => rendered.unmount() }
}
const adjacent = (
  <Box width={40} height={4}>
    <Box width={10} selectionScope>
      <Text>abcdefghij</Text>
    </Box>
    <Box width={10} selectionScope>
      <Text>klmnopqrst</Text>
    </Box>
  </Box>
)
test('actual nearest scope clamps word selection and word drag at an adjacent same-class run', async () => {
  const v = await scene(adjacent)
  try {
    v.ink.startTextSelection(2, 0)
    expect(v.ink.selection.scope).toMatchObject({ x1: 0, x2: 10 })
    v.ink.handleMultiClick(2, 0, 2)
    expect(v.ink.selection.anchor).toEqual({ col: 0, row: 0 })
    expect(v.ink.selection.focus).toEqual({ col: 9, row: 0 })
    v.ink.handleSelectionDrag(19, 0)
    expect(v.ink.selection.focus).toEqual({ col: 9, row: 0 })
    expect(v.ink.getSelectedText()).toBe('abcdefghij')
  } finally {
    v.close()
  }
})
test('actual nearest scope clamps line selection and line drag without including adjacent columns', async () => {
  const v = await scene(adjacent)
  try {
    v.ink.startTextSelection(2, 0)
    v.ink.handleMultiClick(2, 0, 3)
    expect(v.ink.selection.focus).toEqual({ col: 9, row: 0 })
    v.ink.handleSelectionDrag(19, 1)
    expect(v.ink.selection.focus).toEqual({ col: 9, row: 1 })
    expect(v.ink.getSelectedText()).toBe('abcdefghij\n')
  } finally {
    v.close()
  }
})
test('actual scope excludes border and padding, intersects clipping ancestors and restores scoped line edges', async () => {
  const v = await scene(
    <Box width={8} height={4} overflow="hidden">
      <Box
        width={16}
        height={4}
        flexShrink={0}
        selectionScope
        borderStyle="single"
        paddingX={1}
      >
        <Text>abcdefghijkl</Text>
      </Box>
    </Box>,
  )
  try {
    v.ink.startTextSelection(3, 1)
    expect(v.ink.selection.scope).toMatchObject({ x1: 2, x2: 8 })
    v.ink.handleSelectionDrag(30, 1)
    finishSelection(v.ink.selection)
    expect(v.ink.selection.focus).toEqual({ col: 7, row: 1 })
    v.ink.moveSelectionFocus('lineStart')
    expect(v.ink.selection.focus).toEqual({ col: 2, row: 1 })
    v.ink.moveSelectionFocus('lineEnd')
    expect(v.ink.selection.focus).toEqual({ col: 7, row: 1 })
    expect(v.ink.getSelectedText()).toBe('bcdef')
  } finally {
    v.close()
  }
})
test('actual unclipped scope measures asymmetric padding from the correct left and right layout edges', async () => {
  const v = await scene(
    <Box
      width={16}
      height={4}
      selectionScope
      borderStyle="single"
      paddingLeft={1}
      paddingRight={2}
    >
      <Text>abcdefghijkl</Text>
    </Box>,
  )
  try {
    v.ink.startTextSelection(3, 1)
    expect(v.ink.selection.scope).toMatchObject({ x1: 2, x2: 13 })
    v.ink.handleMultiClick(3, 1, 3)
    expect(v.ink.selection.anchor).toEqual({ col: 2, row: 1 })
    expect(v.ink.selection.focus).toEqual({ col: 12, row: 1 })
  } finally {
    v.close()
  }
})
