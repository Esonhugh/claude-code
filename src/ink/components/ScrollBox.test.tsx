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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(predicate()).toBe(true)
}

test('a non-sticky ScrollBox stays at the top when content first overflows', async () => {
  const stdout = new Output()
  const scrollRef = createRef<ScrollBoxHandle>()
  const draw = (count: number) => (
    <ScrollBox
      ref={scrollRef}
      width={40}
      height={4}
      flexShrink={0}
      flexDirection="column"
    >
      {Array.from({ length: count }, (_, index) => (
        <Box key={index} flexShrink={0}>
          <Text>line-{index.toString().padStart(2, '0')}</Text>
        </Box>
      ))}
    </ScrollBox>
  )
  const instance = await render(draw(2), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await waitFor(
      () =>
        scrollRef.current !== null &&
        scrollRef.current.getScrollHeight() > 0 &&
        scrollRef.current.getScrollHeight() <=
          scrollRef.current.getViewportHeight(),
    )
    expect(scrollRef.current?.getScrollTop()).toBe(0)

    instance.rerender(draw(10))
    await waitFor(
      () =>
        scrollRef.current !== null &&
        scrollRef.current.getScrollHeight() >
          scrollRef.current.getViewportHeight(),
    )

    expect(scrollRef.current?.getScrollTop()).toBe(0)
  } finally {
    instance.unmount()
  }
})

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
