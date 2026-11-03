import { expect, test } from 'bun:test'
import React, { createRef } from 'react'
import { Writable } from 'node:stream'
import { Box, Text, render } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from './components/ScrollBox.js'
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

const settle = () => new Promise(resolve => setTimeout(resolve, 60))
const rows = (screen: Parameters<typeof cellAt>[0]) =>
  Array.from({ length: 8 }, (_, y) =>
    Array.from({ length: 40 }, (_, x) => cellAt(screen, x, y)?.char ?? ' ').join('').trimEnd(),
  )

// Like the fullscreen transcript at the top: paddingTop 1 above a bordered
// logo. Scrolling one row must paint the same frame as a full redraw.
test('scrolling a padded ScrollBox keeps the padding row the same as a redraw', async () => {
  const stdout = new Output() as unknown as NodeJS.WriteStream
  const ref = createRef<ScrollBoxHandle>()
  const app = (
    <Box width={40} height={8} flexDirection="column">
      <ScrollBox ref={ref} flexGrow={1} flexDirection="column" paddingTop={1}>
        <Box borderStyle="round" flexShrink={0} flexDirection="column">
          <Text>logo a</Text>
          <Text>logo b</Text>
        </Box>
        {Array.from({ length: 20 }, (_, i) => (
          <Text key={i}>line {i}</Text>
        ))}
      </ScrollBox>
      <Box flexShrink={0}>
        <Text>footer</Text>
      </Box>
    </Box>
  )
  const rendered = await render(app, { stdout, patchConsole: false, exitOnCtrlC: false })
  const ink = instances.get(stdout)! as unknown as {
    frontFrame: { screen: Parameters<typeof cellAt>[0] }
    setAltScreenActive(active: boolean): void
    prevFrameContaminated: boolean
    onRender(): void
  }
  try {
    ink.setAltScreenActive(true)
    rendered.rerender(app)
    await settle()
    ref.current!.scrollTo(0)
    await settle()
    ref.current!.scrollBy(1)
    await settle()
    const scrolled = rows(ink.frontFrame.screen)
    ink.prevFrameContaminated = true
    ink.onRender()
    expect(scrolled).toEqual(rows(ink.frontFrame.screen))
    expect(scrolled[0]).toBe('')
  } finally {
    rendered.unmount()
  }
})
