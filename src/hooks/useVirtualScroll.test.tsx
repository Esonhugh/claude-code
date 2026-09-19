import { Writable } from 'node:stream'
import { expect, test } from 'bun:test'
import React, { createRef } from 'react'
import stripAnsi from 'strip-ansi'
import Box from '../ink/components/Box.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import Text from '../ink/components/Text.js'
import render from '../ink/root.js'
import { useVirtualScroll } from './useVirtualScroll.js'

class Output extends Writable {
  columns = 80
  rows = 20
  isTTY = false
  output = ''

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
    callback()
  }
}

function List({
  scrollRef,
  columns,
  items,
}: {
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  columns: number
  items: string[]
}) {
  const { range, spacerRef, topSpacer, bottomSpacer, measureRef } =
    useVirtualScroll(scrollRef, items, columns)
  return (
    <>
      <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
      {items.slice(...range).map(item => (
        <Box key={item} ref={measureRef(item)} flexShrink={0}>
          <Text>{item}</Text>
        </Box>
      ))}
      <Box height={bottomSpacer} flexShrink={0} />
    </>
  )
}

test.each(['during', 'after'])(
  'bottom-following messages appended %s a resize remain visible',
  async timing => {
    const stdout = new Output()
    const scrollRef = createRef<ScrollBoxHandle>()

    const draw = (columns: number, items: string[]) => (
      <Box width={80} height={20}>
        <ScrollBox
          ref={scrollRef}
          width={columns}
          height={20}
          flexDirection="column"
          stickyScroll
        >
          <List scrollRef={scrollRef} columns={columns} items={items} />
        </ScrollBox>
      </Box>
    )
    const items = ['first message', 'second message', 'third message']
    const instance = await render(draw(80, items), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    })

    try {
      await Bun.sleep(40)
      expect(stripAnsi(stdout.output)).toContain('third message')
      if (timing === 'after') {
        instance.rerender(draw(40, items))
        await Bun.sleep(40)
      }
      stdout.output = ''
      instance.rerender(draw(40, [...items, 'Diff sidebar shown']))
      await Bun.sleep(40)
      expect(stripAnsi(stdout.output)).toContain('Diff sidebar shown')
    } finally {
      instance.unmount()
      instance.cleanup()
    }
  },
)

test('resize and appended messages preserve a scrolled-up viewport', async () => {
  const stdout = new Output()
  const scrollRef = createRef<ScrollBoxHandle>()
  const items = Array.from({ length: 40 }, (_, index) => `message-${index}`)
  const draw = (columns: number, messages: string[]) => (
    <Box width={80} height={20}>
      <ScrollBox
        ref={scrollRef}
        width={columns}
        height={20}
        flexDirection="column"
        stickyScroll
      >
        <List scrollRef={scrollRef} columns={columns} items={messages} />
      </ScrollBox>
    </Box>
  )
  const instance = await render(draw(80, items), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await Bun.sleep(40)
    scrollRef.current!.scrollTo(0)
    await Bun.sleep(40)
    stdout.output = ''
    instance.rerender(draw(80, items))
    await Bun.sleep(40)
    const before = stripAnsi(stdout.output)
    expect(before).toContain('message-0\n')
    expect(scrollRef.current!.isSticky()).toBe(false)
    instance.rerender(draw(40, items))
    await Bun.sleep(40)
    stdout.output = ''
    instance.rerender(draw(40, [...items, 'new tail message']))
    await Bun.sleep(40)
    expect(stripAnsi(stdout.output)).toBe(before)
    expect(scrollRef.current!.isSticky()).toBe(false)
  } finally {
    instance.unmount()
    instance.cleanup()
  }
})
