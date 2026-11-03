import { expect, test } from 'bun:test'
import React from 'react'
import { Writable } from 'node:stream'
import { Box, Text, render } from '../ink.js'
import instances from './instances.js'
import { cellAt } from './screen.js'

class Output extends Writable {
  columns = 40
  rows = 6
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

// Like the fullscreen "N new messages" pill: a full-width absolute row over
// the last row of clean content.
function app(label: string | null) {
  return (
    <Box width={40} height={6} flexDirection="column">
      <Box flexDirection="column">
        {['row zero', 'row one', 'row two', 'row three', 'row four', 'row five'].map(t => (
          <Text key={t}>{t}</Text>
        ))}
      </Box>
      {label !== null && (
        <Box position="absolute" bottom={0} left={0} right={0} justifyContent="center">
          <Text>{label}</Text>
        </Box>
      )}
    </Box>
  )
}

const rowText = (screen: Parameters<typeof cellAt>[0], y: number) =>
  Array.from({ length: 40 }, (_, x) => cellAt(screen, x, y)?.char ?? ' ').join('')

test('changing an absolute overlay keeps the content it does not cover', async () => {
  const stdout = new Output() as unknown as NodeJS.WriteStream
  const rendered = await render(app('1 new'), { stdout, patchConsole: false, exitOnCtrlC: false })
  const ink = instances.get(stdout)! as unknown as {
    frontFrame: { screen: Parameters<typeof cellAt>[0] }
    setAltScreenActive(active: boolean): void
  }
  try {
    ink.setAltScreenActive(true)
    rendered.rerender(app('1 new'))
    await settle()
    expect(rowText(ink.frontFrame.screen, 5)).toStartWith('row five')
    rendered.rerender(app('2 new messages'))
    await settle()
    const row = rowText(ink.frontFrame.screen, 5)
    expect(row).toStartWith('row five')
    expect(row).toContain('2 new messages')
    rendered.rerender(app(null))
    await settle()
    expect(rowText(ink.frontFrame.screen, 5).trimEnd()).toBe('row five')
  } finally {
    rendered.unmount()
  }
})
