import { afterEach, expect, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { Box, render, Text } from '../ink.js'
import { setScreenReaderEnabled } from './screen-reader.js'

afterEach(() => setScreenReaderEnabled(false))

async function renderText(node: React.ReactNode, columns = 40): Promise<string[]> {
  const stdout = Object.assign(new PassThrough(), { columns, rows: 20, isTTY: false })
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  stdout.resume()
  const instance = await render(node, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  try {
    await new Promise(resolve => setTimeout(resolve, 50))
    return stripAnsi(output).split('\n').map(line => line.replace(/\s+$/, '')).filter(line => line !== '')
  } finally {
    instance.unmount()
    instance.cleanup()
  }
}

const tree = (
  <Box flexDirection="column" borderStyle="round" paddingX={2}>
    <Box flexDirection="row" gap={3}>
      <Text aria-hidden>●</Text>
      <Text bold>first</Text>
      <Text>second</Text>
    </Box>
    <Text>a long line that is wider than twenty columns</Text>
  </Box>
)

test('screen-reader mode renders flat text: no borders, decorative glyphs or padding, long lines wrapped', async () => {
  setScreenReaderEnabled(true)
  expect(await renderText(tree, 20)).toEqual(['first second', 'a long line that is', 'wider than twenty', 'columns'])
})

test('normal mode keeps the borders and the decorative glyphs', async () => {
  const lines = await renderText(tree, 60)
  expect(lines[0]).toStartWith('╭')
  expect(lines.join('\n')).toContain('●')
})
