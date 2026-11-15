import { expect, test } from 'bun:test'
import React, { createRef, useMemo, useState } from 'react'
import { Writable } from 'node:stream'
import { Box, Text, render } from '../ink.js'
import { OffscreenFreeze } from '../components/OffscreenFreeze.js'
import { useVirtualScroll } from '../hooks/useVirtualScroll.js'
import ScrollBox, { type ScrollBoxHandle } from './components/ScrollBox.js'
import instances from './instances.js'
import { cellAt } from './screen.js'

class Output extends Writable {
  columns = 120
  rows = 32
  isTTY = false
  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

const Header = React.memo(function Header() {
  return (
    <OffscreenFreeze>
      <Box flexDirection="column">
        <Text>WELCOME_HEADER</Text>
        <Text>session details</Text>
      </Box>
    </OffscreenFreeze>
  )
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000
  while (!predicate() && performance.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(predicate()).toBe(true)
}

test.each([0, 3])('shrinking resumed virtual history to %i items restores the welcome header', async remaining => {
  const stdout = new Output() as unknown as NodeJS.WriteStream
  const scrollRef = createRef<ScrollBoxHandle>()
  const invalidRanges: { count: number; start: number; end: number }[] = []
  function History({ count }: { count: number }) {
    const keys = useMemo(() => Array.from({ length: count }, (_, i) => String(i)), [count])
    const { range: [start, end], topSpacer, bottomSpacer, spacerRef, measureRef } = useVirtualScroll(scrollRef, keys, 120)
    if (start < 0 || start > end || end > count) {
      invalidRanges.push({ count, start, end })
    }
    return (
      <>
        <Box ref={spacerRef} height={topSpacer} flexShrink={0} />
        {keys.slice(start, end).map(key => (
          <Box key={key} ref={measureRef(key)} flexDirection="column">
            <Text>history {key}</Text>
            <Text>second line</Text>
          </Box>
        ))}
        <Box height={bottomSpacer} flexShrink={0} />
      </>
    )
  }
  let updateCount: (count: number) => void
  function App() {
    const [count, setCount] = useState(3000)
    updateCount = setCount
    return (
      <Box height={32} width={120} flexDirection="column">
        <ScrollBox ref={scrollRef} stickyScroll flexGrow={1} flexShrink={1} flexDirection="column">
          <Header />
          <History count={count} />
        </ScrollBox>
        <Text>PROMPT_INPUT</Text>
      </Box>
    )
  }
  const rendered = await render(<App />, { stdout, patchConsole: false, exitOnCtrlC: false })
  const ink = instances.get(stdout)! as unknown as { frontFrame: { screen: Parameters<typeof cellAt>[0] } }
  const text = () => Array.from({ length: 32 }, (_, y) => Array.from({ length: 120 }, (_, x) => cellAt(ink.frontFrame.screen, x, y)?.char ?? ' ').join('')).join('\n')
  try {
    await waitFor(() => text().includes('history 2999'))
    scrollRef.current!.scrollBy(-400)
    updateCount!(remaining)
    await waitFor(() => text().includes('WELCOME_HEADER'))
    expect(invalidRanges).toEqual([])
    expect(text()).toContain('WELCOME_HEADER')
    expect(text()).toContain('PROMPT_INPUT')
    expect(scrollRef.current!.getScrollTop()).toBe(0)
    expect(scrollRef.current!.getElement()!.scrollTopRendered).toBe(0)
    if (remaining > 0) expect(text()).toContain(`history ${remaining - 1}`)
    updateCount!(remaining + 1)
    await waitFor(() => text().includes(`history ${remaining}`))
    expect(text()).toContain('WELCOME_HEADER')
  } finally {
    rendered.unmount()
    rendered.cleanup()
    stdout.destroy()
  }
}, 10000)
