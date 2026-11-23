import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import React, { createRef, useState } from 'react'

const configDir = mkdtempSync(join(tmpdir(), 'virtual-list-search-test-'))
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

const { Text, render } = await import('../ink.js')
const { default: ScrollBox } = await import('../ink/components/ScrollBox.js')
type ScrollBoxHandle = import('../ink/components/ScrollBox.js').ScrollBoxHandle
type RenderableMessage = import('../types/message.js').RenderableMessage
const { createUserMessage } = await import('../utils/messages.js')
const { VirtualMessageList } = await import('./VirtualMessageList.js')
type JumpHandle = import('./VirtualMessageList.js').JumpHandle

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

class Output extends Writable {
  columns = 80
  rows = 10
  isTTY = false

  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

// "foo" in every tenth message; `extra` stands in for the Code Mode script
// text Ctrl+E adds to (or removes from) the searchable text.
const messages = Array.from({ length: 50 }, (_, i) => createUserMessage({ content: `row ${i}` }))
const searchText = (extra: Set<number>, without: Set<number> = new Set()) => (msg: RenderableMessage) => {
  const i = messages.indexOf(msg as never)
  return (i % 10 === 0 && !without.has(i)) || extra.has(i) ? `row ${i} foo` : `row ${i}`
}

async function waitFor(what: string, predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000
  while (!predicate() && performance.now() < deadline) await Bun.sleep(5)
  if (!predicate()) throw new Error(`timed out waiting for ${what}`)
}

async function mount() {
  const stdout = new Output()
  const scrollRef = createRef<ScrollBoxHandle>()
  const jumpRef = createRef<JumpHandle>() as React.RefObject<JumpHandle | null>
  const badge = { count: 0, current: 0 }
  let highlighted = 0
  let setExtract!: (f: (msg: RenderableMessage) => string) => void
  function List() {
    const [extract, set] = useState(() => searchText(new Set()))
    setExtract = f => set(() => f)
    return (
      <ScrollBox ref={scrollRef} width={80} height={10} flexDirection="column" stickyScroll>
        <VirtualMessageList
          messages={messages}
          scrollRef={scrollRef}
          columns={80}
          itemKey={msg => msg.uuid}
          renderItem={msg => <Text>{(msg as { message: { content: string } }).message.content}</Text>}
          extractSearchText={extract}
          jumpRef={jumpRef}
          scanElement={() => [{ row: 0, col: 0, len: 3 }]}
          setPositions={state => {
            if (state) highlighted++
          }}
          onSearchMatchesChange={(count, current) => Object.assign(badge, { count, current })}
        />
      </ScrollBox>
    )
  }
  const instance = await render(<List />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await waitFor('the viewport', () => scrollRef.current?.getViewportHeight() === 10)
  await waitFor('the bottom', () => scrollRef.current!.getScrollTop() === 40)
  const jump = jumpRef.current!
  // `/foo` from the bottom lands on row 40; `N` steps back to row 30.
  jump.setAnchor()
  jump.setSearchQuery('foo')
  await waitFor('the first match', () => highlighted > 0)
  expect(badge).toEqual({ count: 5, current: 5 })
  const seen = highlighted
  jump.prevMatch()
  await waitFor('the previous match', () => highlighted > seen)
  expect(badge).toEqual({ count: 5, current: 4 })
  return {
    jump,
    badge,
    scrollTop: () => scrollRef.current!.getScrollTop(),
    highlighted: () => highlighted,
    change: async (f: (msg: RenderableMessage) => string) => {
      const before = jumpRef.current
      setExtract(f)
      await waitFor('the new handle', () => jumpRef.current !== before)
      return jumpRef.current!
    },
    close: () => {
      instance.unmount()
      instance.cleanup()
      stdout.destroy()
    },
  }
}

test('Ctrl+E re-counts the search and stays on the current match, not the / anchor', async () => {
  const list = await mount()
  try {
    const seen = list.highlighted()
    ;(await list.change(searchText(new Set([25])))).refreshSearch('foo')
    await waitFor('the re-highlight', () => list.highlighted() > seen)
    // Row 30 is the fifth of 0, 10, 20, 25, 30, 40; the anchor's row 40 would be the sixth.
    expect(list.badge).toEqual({ count: 6, current: 5 })
    expect(list.scrollTop()).toBeLessThan(35)
  } finally {
    list.close()
  }
})

test('after a manual scroll the re-count neither scrolls nor highlights', async () => {
  const list = await mount()
  try {
    list.jump.disarmSearch()
    const seen = list.highlighted()
    const top = list.scrollTop()
    ;(await list.change(searchText(new Set([25])))).refreshSearch('foo')
    await Bun.sleep(50)
    expect(list.badge.count).toBe(6)
    expect(list.scrollTop()).toBe(top)
    expect(list.highlighted()).toBe(seen)
  } finally {
    list.close()
  }
})

test('hiding the only matches clears the count without jumping back to the / anchor', async () => {
  const list = await mount()
  try {
    const top = list.scrollTop()
    ;(await list.change(searchText(new Set(), new Set([0, 10, 20, 30, 40])))).refreshSearch('foo')
    await Bun.sleep(50)
    expect(list.badge).toEqual({ count: 0, current: 0 })
    expect(list.scrollTop()).toBe(top)
  } finally {
    list.close()
  }
})
