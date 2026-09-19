import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { describe, expect, test } from 'bun:test'
import React, { createRef, useEffect, useRef, useState } from 'react'
import { Box, Text, ThemeProvider, render, useStdin } from '../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import { KeybindingProvider } from '../keybindings/KeybindingContext.js'
import { DEFAULT_BINDINGS } from '../keybindings/defaultBindings.js'
import { parseBindings } from '../keybindings/parser.js'
import type { KeybindingContextName, ParsedKeystroke } from '../keybindings/types.js'
import type { ModUiPane } from '../services/mods/ui.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { ModsPane } from './ModsPane.js'
import { ScrollKeybindingHandler } from './ScrollKeybindingHandler.js'

class Output extends Writable {
  columns = 80
  rows = 30
  isTTY = false

  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class Input extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }
  ref() { return this }
  unref() { return this }
}

const bindings = parseBindings(DEFAULT_BINDINGS)

function Providers({ children }: { children: React.ReactNode }) {
  // The REPL still reads modal input when every transcript handler is inactive.
  const { setRawMode } = useStdin()
  useEffect(() => {
    setRawMode(true)
    return () => setRawMode(false)
  }, [setRawMode])
  const [store] = useState(() => createStore(getDefaultAppState()))
  const pending = useRef<ParsedKeystroke[] | null>(null)
  const registry = useRef(new Map())
  const contexts = useRef(new Set<KeybindingContextName>(['Global', 'Scroll']))
  return (
    <AppStoreContext.Provider value={store}>
      <KeybindingProvider
        bindings={bindings}
        pendingChordRef={pending}
        pendingChord={null}
        setPendingChord={value => { pending.current = value }}
        activeContexts={contexts.current}
        registerActiveContext={value => { contexts.current.add(value) }}
        unregisterActiveContext={value => { contexts.current.delete(value) }}
        handlerRegistryRef={registry}
      >
        {children}
      </KeybindingProvider>
    </AppStoreContext.Provider>
  )
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 80))
}

async function mount({ focused = true, isActive = true } = {}) {
  const stdout = new Output()
  const stdin = new Input()
  const scrollRef = createRef<ScrollBoxHandle>()
  const transcriptScrolls: boolean[] = []
  const paneScrolls: number[] = []
  const domKeys: string[] = []
  const pane: ModUiPane = {
    id: 'scroll-test',
    title: 'Scroll test',
    plugin: 'fixture',
    owner: {},
    visible: true,
    placement: 'inline',
    focused,
    closeOnEscape: false,
    holdToasts: false,
    scrollOffset: 0,
    bodyRows: 6,
    bodyColumns: 80,
    revision: 0,
    contentRows: 30,
    drawing: 1,
    tree: { type: 'Text', children: ['Pane body'] },
  }
  const draw = () => (
    <Providers>
      <Box flexDirection="column" width={80} height={20}>
        <ScrollKeybindingHandler
          scrollRef={scrollRef}
          isActive={isActive}
          isKeyboardActive={!focused}
          onScroll={sticky => { transcriptScrolls.push(sticky) }}
        />
        <ScrollBox ref={scrollRef} height={10} flexShrink={0} flexDirection="column">
          {Array.from({ length: 60 }, (_, index) => <Text key={index}>Transcript {index}</Text>)}
        </ScrollBox>
        <Box onKeyDownCapture={event => { domKeys.push(`${event.ctrl ? 'ctrl+' : ''}${event.key}`) }}>
          <ModsPane
            pane={{ ...pane, focused }}
            onInteract={async () => {}}
            onClose={async () => {}}
            onFocus={async () => {}}
            onScroll={async (_pane, by) => { paneScrolls.push(by) }}
          />
        </Box>
      </Box>
    </Providers>
  )
  const instance = await render(draw(), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await settle()
  assert.ok(scrollRef.current)
  const scroll = scrollRef.current
  expect(scroll.getViewportHeight()).toBe(10)
  expect(scroll.getScrollHeight()).toBe(60)
  scroll.scrollTo(20)
  await settle()
  return {
    scroll,
    transcriptScrolls,
    paneScrolls,
    domKeys,
    async input(sequence: string) {
      stdin.push(sequence)
      await settle()
    },
    async update(next: { focused?: boolean; isActive?: boolean }) {
      focused = next.focused ?? focused
      isActive = next.isActive ?? isActive
      // render() adds ThemeProvider; rerender() expects the already-wrapped tree.
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(scrollRef.current).toBe(scroll)
    },
    unmount: () => instance.unmount(),
  }
}

describe('ScrollKeybindingHandler input routing', () => {
  test('lets a focused Mods pane receive PageDown without scrolling the transcript', async () => {
    const view = await mount()
    try {
      await view.input('\u001b[6~')
      expect(view.scroll.getScrollTop()).toBe(20)
      expect(view.transcriptScrolls).toEqual([])
      expect(view.domKeys).toEqual(['pagedown'])
      expect(view.paneScrolls).toEqual([6])
    } finally {
      view.unmount()
    }
  })

  test.each([
    { name: 'PageUp', sequence: '\u001b[5~', key: 'pageup', paneScrolls: [-6] },
    { name: 'Home', sequence: '\u001b[H', key: 'home', paneScrolls: [-30] },
    { name: 'End', sequence: '\u001b[F', key: 'end', paneScrolls: [30] },
    { name: 'Ctrl+Home', sequence: '\u001b[1;5H', key: 'ctrl+home', paneScrolls: [] },
    { name: 'Ctrl+End', sequence: '\u001b[1;5F', key: 'ctrl+end', paneScrolls: [] },
  ])('lets $name reach the focused pane DOM without scrolling the transcript', async ({ sequence, key, paneScrolls }) => {
    const view = await mount()
    try {
      await view.input(sequence)
      expect(view.scroll.getScrollTop()).toBe(20)
      expect(view.scroll.getPendingDelta()).toBe(0)
      expect(view.transcriptScrolls).toEqual([])
      expect(view.domKeys).toEqual([key])
      expect(view.paneScrolls).toEqual([...paneScrolls])
    } finally {
      view.unmount()
    }
  })

  test('keeps outside wheel scrolling active while the pane owns keyboard input', async () => {
    const view = await mount()
    try {
      // SGR coordinates are one-based; row 1 is inside the transcript.
      await view.input('\u001b[<65;1;1M')
      expect(view.scroll.getScrollTop()).toBeGreaterThan(20)
      expect(view.transcriptScrolls).toEqual([false])
      expect(view.paneScrolls).toEqual([])
      const top = view.scroll.getScrollTop()
      // Row 12 is the pane body, below the ten-row transcript and pane title.
      await view.input('\u001b[<65;1;12M')
      expect(view.scroll.getScrollTop()).toBe(top)
      expect(view.transcriptScrolls).toEqual([false])
      expect(view.paneScrolls).toEqual([1])
    } finally {
      view.unmount()
    }
  })

  test('restores Page and top/bottom shortcuts after the pane loses focus', async () => {
    const view = await mount()
    try {
      await view.update({ focused: false })
      await view.input('\u001b[6~')
      expect(view.scroll.getScrollTop()).toBe(25)
      await view.input('\u001b[5~')
      expect(view.scroll.getScrollTop()).toBe(20)
      await view.input('\u001b[1;5H')
      expect(view.scroll.getScrollTop()).toBe(0)
      await view.input('\u001b[1;5F')
      expect(view.scroll.getScrollTop()).toBe(50)
      expect(view.scroll.isSticky()).toBe(true)
      expect(view.transcriptScrolls).toEqual([false, false, false, true])
      expect(view.paneScrolls).toEqual([])
      expect(view.domKeys).toEqual([])
    } finally {
      view.unmount()
    }
  })

  test('preserves the existing modal isActive gate for keyboard and wheel input', async () => {
    const view = await mount({ isActive: false })
    try {
      await view.input('\u001b[6~')
      expect(view.domKeys).toEqual(['pagedown'])
      expect(view.paneScrolls).toEqual([6])
      await view.update({ focused: false })
      for (const sequence of ['\u001b[5~', '\u001b[6~', '\u001b[1;5H', '\u001b[1;5F', '\u001b[<65;1;1M']) {
        await view.input(sequence)
        expect(view.scroll.getScrollTop()).toBe(20)
        expect(view.scroll.getPendingDelta()).toBe(0)
      }
      expect(view.transcriptScrolls).toEqual([])
      await view.update({ isActive: true })
      await view.input('\u001b[6~')
      expect(view.scroll.getScrollTop()).toBe(25)
      await view.input('\u001b[<65;1;1M')
      expect(view.scroll.getScrollTop()).toBeGreaterThan(25)
      expect(view.transcriptScrolls).toEqual([false, false])
    } finally {
      view.unmount()
    }
  })
})
