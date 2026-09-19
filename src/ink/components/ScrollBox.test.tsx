import { Writable } from 'node:stream'
import { expect, test } from 'bun:test'
import React, { createRef } from 'react'
import stripAnsi from 'strip-ansi'
import { Box, Text, render } from '../../ink.js'
import ScrollBox, { type ScrollBoxHandle } from './ScrollBox.js'

class Output extends Writable {
  columns = 40
  rows = 4
  isTTY = false
  output = ''

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
    callback()
  }
}

test('a horizontally constrained ScrollBox does not shift sibling columns', async () => {
  const stdout = new Output()
  const scrollRef = createRef<ScrollBoxHandle>()
  const instance = await render(
    <Box width={40} height={4} flexDirection="row">
      <Box width={20} flexShrink={0} flexDirection="column">
        {Array.from({ length: 4 }, (_, index) => (
          <Text key={index}>left-{index.toString().padStart(2, '0')}</Text>
        ))}
      </Box>
      <ScrollBox
        ref={scrollRef}
        width={20}
        height={4}
        flexShrink={0}
        flexDirection="column"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <Text key={index}>right-{index.toString().padStart(2, '0')}</Text>
        ))}
      </ScrollBox>
    </Box>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )

  try {
    expect(scrollRef.current).not.toBeNull()
    stdout.output = ''
    scrollRef.current!.scrollTo(2)
    await new Promise(resolve => setTimeout(resolve, 40))

    const rows = stripAnsi(stdout.output).split('\n')
    expect(rows.map(row => row.slice(0, 20).trimEnd())).toEqual([
      'left-00',
      'left-01',
      'left-02',
      'left-03',
    ])
    expect(rows[0]?.slice(20).trim()).toBe('right-02')
  } finally {
    instance.unmount()
  }
})
