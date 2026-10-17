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
  onRender,
}: {
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  columns: number
  items: string[]
  onRender?: (mounted: number, topSpacer: number) => void
}) {
  const { range, spacerRef, topSpacer, bottomSpacer, measureRef } =
    useVirtualScroll(scrollRef, items, columns)
  onRender?.(range[1] - range[0], topSpacer)
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000
  while (!predicate() && performance.now() < deadline) {
    await Bun.sleep(5)
  }
  expect(predicate()).toBe(true)
}

test.each([
  { from: 90, delta: 240 },
  { from: 90, delta: 600 },
  { from: 90, delta: 1200 },
  { from: 1500, delta: -240 },
  { from: 1500, delta: -600 },
  { from: 1500, delta: -1200 },
])(
  'a burst from $from by $delta reaches the visible target without more input',
  async ({ from, delta }) => {
    const env = {
      NODE_ENV: process.env.NODE_ENV,
      TERM_PROGRAM: process.env.TERM_PROGRAM,
    }
    process.env.NODE_ENV = 'production'
    process.env.TERM_PROGRAM = 'vscode'
    const stdout = new Output()
    const scrollRef = createRef<ScrollBoxHandle>()
    const items = Array.from(
      { length: 2000 },
      (_, index) => `message-${index}\nbody one\nbody two`,
    )
    let renders = 0
    let maxMounted = 0
    let paintedTop = -1
    const instance = await render(
      <ScrollBox
        ref={scrollRef}
        width={80}
        height={20}
        flexDirection="column"
        stickyScroll
      >
        <List
          scrollRef={scrollRef}
          columns={80}
          items={items}
          onRender={mounted => {
            renders++
            maxMounted = Math.max(maxMounted, mounted)
          }}
        />
      </ScrollBox>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        patchConsole: false,
        exitOnCtrlC: false,
        onFrame: () => {
          const s = scrollRef.current
          const el = s?.getElement()
          if (s && el) {
            paintedTop = Math.max(
              el.scrollClampMin ?? 0,
              Math.min(s.getScrollTop(), el.scrollClampMax ?? Infinity),
            )
          }
        },
      },
    )
    try {
      await waitFor(() => scrollRef.current?.getViewportHeight() === 20)
      scrollRef.current!.scrollTo(from)
      await waitFor(() => paintedTop === from)
      stdout.output = ''
      scrollRef.current!.scrollBy(delta)
      await waitFor(() => scrollRef.current!.getPendingDelta() === 0)
      expect(scrollRef.current!.getScrollTop()).toBe(from + delta)
      await waitFor(() => paintedTop === from + delta)
      expect(stripAnsi(stdout.output)).toContain(
        `message-${(from + delta) / 3}\n`,
      )
      expect(maxMounted).toBeLessThanOrEqual(300)
      await Bun.sleep(80)
      const settledRenders = renders
      await Bun.sleep(80)
      expect(renders).toBe(settledRenders)
    } finally {
      instance.unmount()
      instance.cleanup()
      stdout.destroy()
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)

// A wheel burst whose accumulated step reaches the top makes scrollUp take its
// scrollTo(0) branch. Sticky leaves the clamp bounds undefined, so the frame
// painted between that jump and React's next commit lands far outside the
// mounted range and the viewport shows bare spacer instead of messages.
// Asserted on the bounds rather than on a captured frame: whether the bad
// frame is actually painted depends on commit/paint ordering, so observing it
// is inherently racy.
test('breaking the sticky bottom leaves the paint inside the mounted range', async () => {
  const stdout = new Output()
  const scrollRef = createRef<ScrollBoxHandle>()
  const VIEWPORT = 20
  const items = Array.from(
    { length: 2000 },
    (_, index) => `message-${index}\nbody one\nbody two`,
  )
  let topSpacer = 0
  const instance = await render(
    <ScrollBox
      ref={scrollRef}
      width={80}
      height={VIEWPORT}
      flexDirection="column"
      stickyScroll
    >
      <List
        scrollRef={scrollRef}
        columns={80}
        items={items}
        onRender={(_mounted, spacer) => {
          topSpacer = spacer
        }}
      />
    </ScrollBox>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  try {
    await waitFor(() => scrollRef.current?.getViewportHeight() === VIEWPORT)
    await waitFor(() => scrollRef.current?.isSticky() === true)
    // Tail mounted, so everything above it is unmounted spacer.
    await waitFor(() => topSpacer > 0)
    const mountedTop = topSpacer
    scrollRef.current!.scrollTo(0)
    const el = scrollRef.current!.getElement()!
    // The exact expression render-node-to-output paints with.
    const painted = Math.max(
      el.scrollClampMin ?? 0,
      Math.min(el.scrollTop ?? 0, el.scrollClampMax ?? Infinity),
    )
    expect(painted).toBeGreaterThanOrEqual(mountedTop)
  } finally {
    instance.unmount()
    instance.cleanup()
    stdout.destroy()
  }
})

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
