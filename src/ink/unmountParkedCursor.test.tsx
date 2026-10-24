import { expect, test } from 'bun:test'
import React from 'react'
import { PassThrough, Writable } from 'node:stream'
import { Box, Text, render } from '../ink.js'
import { useDeclaredCursor } from './hooks/use-declared-cursor.js'
import { cursorMove } from './termio/csi.js'

function Input() {
  const ref = useDeclaredCursor({ line: 0, column: 3, active: true })
  return <Box ref={ref}><Text>abc</Text></Box>
}

test('unmount on the main screen moves a parked cursor back below the last frame', async () => {
  let output = ''
  const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback() } })
  Object.assign(stdout, { columns: 40, rows: 10, isTTY: true })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const app = await render(
    <Box flexDirection="column"><Input /><Text>below 1</Text><Text>below 2</Text></Box>,
    { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false },
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  const before = output.length
  app.unmount()
  expect(output.slice(before)).toContain(cursorMove(-3, 3))
})
