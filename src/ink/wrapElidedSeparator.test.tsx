import { afterAll, beforeAll, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'
import { Writable } from 'node:stream'
import { Box, Text, render } from '../ink.js'
import instances from './instances.js'
import { cellAt } from './screen.js'

class Output extends Writable {
  columns = 40
  rows = 8
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}
type Screen = Parameters<typeof cellAt>[0]

let previousLevel: typeof chalk.level
beforeAll(() => {
  previousLevel = chalk.level
  chalk.level = 2
})
afterAll(() => {
  chalk.level = previousLevel
})

async function scene(node: React.ReactNode) {
  const stdout = new Output() as unknown as NodeJS.WriteStream
  const rendered = await render(node, { stdout, patchConsole: false, exitOnCtrlC: false })
  const ink = instances.get(stdout)!
  ink.setAltScreenActive(true)
  rendered.rerender(node)
  await new Promise(resolve => setTimeout(resolve, 50))
  const screen = (ink as unknown as { frontFrame: { screen: Screen } }).frontFrame.screen
  const row = (y: number) => {
    let text = ''
    for (let col = 0; col < screen.width; col++) text += cellAt(screen, col, y)?.char || ' '
    return text.trimEnd()
  }
  const copy = (fromCol: number, fromRow: number, toCol: number, toRow: number) => {
    ink.startTextSelection(fromCol, fromRow)
    ink.handleSelectionDrag(toCol, toRow)
    return ink.getSelectedText()
  }
  return { screen, row, copy, close: () => rendered.unmount() }
}

// The first row is exactly as wide as the box, so wrapAnsi leaves the separator space on the next row.
test('a soft-wrapped continuation row drops its leading separator space, and copying restores it', async () => {
  const v = await scene(<Box width={10}><Text>aaaa bbbbb ccccc</Text></Box>)
  try {
    expect([v.row(0), v.row(1)]).toEqual(['aaaa bbbbb', 'ccccc'])
    expect(v.copy(0, 0, 9, 1)).toBe('aaaa bbbbb ccccc')
    expect(v.copy(0, 1, 9, 1)).toBe('ccccc')
  } finally {
    v.close()
  }
})

test('only one separator space is dropped and a row holding nothing else keeps it', async () => {
  const v = await scene(<Box width={10}><Text>{'aaaa bbbbb   ccccc\ndddd eeeee '}</Text></Box>)
  try {
    expect([v.row(0), v.row(1), v.row(2), v.row(3)]).toEqual(['aaaa bbbbb', '  ccccc', 'dddd eeeee', ''])
    expect(v.copy(0, 0, 9, 3)).toBe('aaaa bbbbb   ccccc\ndddd eeeee')
  } finally {
    v.close()
  }
})

test('styles stay on their own characters after the separator space is dropped', async () => {
  const v = await scene(<Box width={10}><Text>aaaa bbbbb <Text inverse>ccccc</Text> d</Text></Box>)
  try {
    expect(v.row(1)).toBe('ccccc d')
    const plain = cellAt(v.screen, 0, 0)!.styleId
    const styles = [0, 4, 6].map(col => cellAt(v.screen, col, 1)!.styleId)
    expect(styles[0]).not.toBe(plain)
    expect(styles).toEqual([styles[0]!, styles[0]!, plain])
  } finally {
    v.close()
  }
})

test('wrap-trim rows are unchanged', async () => {
  const v = await scene(<Box width={10}><Text wrap="wrap-trim">aaaa bbbbb ccccc</Text></Box>)
  try {
    expect([v.row(0), v.row(1)]).toEqual(['aaaa bbbbb', 'ccccc'])
  } finally {
    v.close()
  }
})
