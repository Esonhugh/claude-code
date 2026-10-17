import { expect, test } from 'bun:test'
import React from 'react'
import { Writable } from 'node:stream'
import { Box, Text, render } from '../ink.js'
import instances from './instances.js'
import type { RenderOptions } from './renderer.js'
import { cellAt } from './screen.js'
import { finishSelection } from './selection.js'

class Output extends Writable {
  columns = 40
  rows = 8
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

function app(tick: number) {
  return (
    <Box width={40} height={8} flexDirection="column">
      <Text>selected words stay put</Text>
      <Text>{`tick ${tick}`}</Text>
    </Box>
  )
}

test('an unchanged selection keeps the previous frame blittable while other rows repaint', async () => {
  const stdout = new Output() as unknown as NodeJS.WriteStream
  const rendered = await render(app(0), { stdout, patchConsole: false, exitOnCtrlC: false })
  const ink = instances.get(stdout)! as unknown as {
    renderer: (options: RenderOptions) => unknown
    frontFrame: { screen: Parameters<typeof cellAt>[0] }
    setAltScreenActive(active: boolean): void
    startTextSelection(col: number, row: number): void
    handleMultiClick(col: number, row: number, count: 2 | 3): void
    selection: Parameters<typeof finishSelection>[0]
  }
  try {
    ink.setAltScreenActive(true)
    rendered.rerender(app(0))
    await settle()
    ink.startTextSelection(2, 0)
    ink.handleMultiClick(2, 0, 2)
    finishSelection(ink.selection)
    rendered.rerender(app(1))
    await settle()
    const selectedStyle = cellAt(ink.frontFrame.screen, 2, 0)!.styleId
    expect(selectedStyle).not.toBe(cellAt(ink.frontFrame.screen, 12, 0)!.styleId)

    const contaminated: boolean[] = []
    const renderer = ink.renderer
    ink.renderer = options => {
      contaminated.push(options.prevFrameContaminated)
      return renderer(options)
    }
    for (const tick of [2, 3]) {
      rendered.rerender(app(tick))
      await settle()
    }
    // Repainting the same overlay over blitted cells is idempotent, so the
    // selection alone no longer forces every following frame to rewrite.
    expect(contaminated).toEqual([false, false])
    expect(cellAt(ink.frontFrame.screen, 2, 0)!.styleId).toBe(selectedStyle)
    expect(cellAt(ink.frontFrame.screen, 5, 1)!.char).toBe('3')
  } finally {
    rendered.unmount()
  }
})
