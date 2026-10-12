import { expect, spyOn, test } from 'bun:test'
import * as config from '../utils/config.js'
import React, { createRef, useEffect, useRef, useState } from 'react'
import { Readable, Writable } from 'node:stream'
import { Box, Text, render, useStdin } from '../ink.js'
import instances from './instances.js'
import ScrollBox, { type ScrollBoxHandle } from './components/ScrollBox.js'
import { finishSelection, updateSelection } from './selection.js'
import { ScrollKeybindingHandler } from '../components/ScrollKeybindingHandler.js'
import { KeybindingProvider } from '../keybindings/KeybindingContext.js'
import { DEFAULT_BINDINGS } from '../keybindings/defaultBindings.js'
import { parseBindings } from '../keybindings/parser.js'
import type {
  KeybindingContextName,
  KeybindingBlock,
  ParsedKeystroke,
} from '../keybindings/types.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
class Output extends Writable {
  columns = 40
  rows = 8
  isTTY = false
  text = ''
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.text += chunk.toString()
    callback()
  }
  copies(): string[] {
    return this.text.split('\x1b]52;c;').slice(1).map(value => {
      const end = [value.indexOf('\x07'), value.indexOf('\x1b\\')]
        .filter(index => index >= 0)
      if (end.length === 0) throw new Error('Unterminated OSC52 write')
      return Buffer.from(value.slice(0, Math.min(...end)), 'base64').toString()
    })
  }
}
class Input extends Readable {
  isTTY = true
  isRaw = false
  _read() {}
  setRawMode(v: boolean) {
    this.isRaw = v
    return this
  }
  ref() {
    return this
  }
  unref() {
    return this
  }
}
function Providers({
  children,
  extra = [],
}: {
  children: React.ReactNode
  extra?: KeybindingBlock[]
}) {
  const { setRawMode } = useStdin()
  useEffect(() => {
    setRawMode(true)
    return () => setRawMode(false)
  }, [setRawMode])
  const [store] = useState(() => createStore(getDefaultAppState())),
    pending = useRef<ParsedKeystroke[] | null>(null),
    registry = useRef(new Map()),
    contexts = useRef(new Set<KeybindingContextName>(['Global', 'Scroll']))
  return (
    <AppStoreContext.Provider value={store}>
      <KeybindingProvider
        bindings={parseBindings([...DEFAULT_BINDINGS, ...extra])}
        pendingChordRef={pending}
        pendingChord={null}
        setPendingChord={(v) => {
          pending.current = v
        }}
        activeContexts={contexts.current}
        registerActiveContext={(v) => {
          contexts.current.add(v)
        }}
        unregisterActiveContext={(v) => {
          contexts.current.delete(v)
        }}
        handlerRegistryRef={registry}
      >
        {children}
      </KeybindingProvider>
    </AppStoreContext.Provider>
  )
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 70))
}
async function scene(count = 12, extra: KeybindingBlock[] = []) {
  const output = new Output(),
    stdin = new Input(),
    stdout = output as unknown as NodeJS.WriteStream,
    left = createRef<ScrollBoxHandle>(),
    right = createRef<ScrollBoxHandle>(),
    old = instances.get(process.stdout)
  const rows = (prefix: string) =>
    Array.from({ length: count }, (_, i) => (
      <Text key={i}>{prefix + i.toString().padStart(2, '0')}</Text>
    ))
  const node = (
    <Providers extra={extra}>
      <Box width={40} height={8} flexDirection="row">
        <ScrollKeybindingHandler scrollRef={left} isActive />
        <ScrollBox ref={left} width={20} height={4} flexDirection="column">
          {rows('left-')}
        </ScrollBox>
        <ScrollBox ref={right} width={20} height={4} flexDirection="column">
          {rows('right-')}
        </ScrollBox>
      </Box>
    </Providers>
  )
  const rendered = await render(node, {
      stdout,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    }),
    ink = instances.get(stdout)!
  // Official LA, like this useSelection, intentionally resolves the singleton via process.stdout.
  // Bind this real private Ink instance in this isolated test process; never write process.stdout.
  instances.set(process.stdout, ink)
  ink.setAltScreenActive(true)
  rendered.rerender(node)
  await settle()
  const select = (col = 0) => {
    ink.startTextSelection(col, 1)
    updateSelection(ink.selection, col + 6 + (col === 20 ? 1 : 0), 1)
    finishSelection(ink.selection)
  }
  return {
    ink,
    output,
    scroll: left.current!,
    select,
    async input(value: string) {
      stdin.push(value)
      await settle()
    },
    close() {
      rendered.unmount()
      if (old) instances.set(process.stdout, old)
      else instances.delete(process.stdout)
    },
  }
}
test('actual Page/Home/End inputs translate once through the painted frame and preserve copy text', async () => {
  const v = await scene()
  try {
    v.select()
    expect(v.ink.getSelectedText()).toBe('left-01')
    await v.input('\x1b[6~')
    expect(v.scroll.getElement()!.scrollTopRendered).toBe(2)
    expect(v.ink.selection.virtualAnchorRow).toBe(-1)
    expect(v.ink.getSelectedText()).toBe('left-01')
    await v.input('\x1b[5~')
    expect(v.ink.selection.anchor).toEqual({ col: 0, row: 1 })
    expect(v.ink.selection.focus).toEqual({ col: 6, row: 1 })
    await v.input('\x1b[1;5F')
    expect(v.ink.selection.virtualAnchorRow).toBe(-7)
    expect(v.ink.getSelectedText()).toBe('left-01')
    await v.input('\x1b[1;5H')
    expect(v.ink.selection.anchor).toEqual({ col: 0, row: 1 })
    expect(v.ink.getSelectedText()).toBe('left-01')
  } finally {
    v.close()
  }
})
test.each([2, 12])(
  'actual wheel keeps selection when rows=%s including content-fit no-op',
  async (count) => {
    const v = await scene(count)
    try {
      v.select()
      await v.input('\x1b[<65;1;2M')
      expect(v.ink.hasTextSelection()).toBe(true)
      expect(v.ink.getSelectedText()).toBe('left-01')
    } finally {
      v.close()
    }
  },
)
test('actual drag timer shifts anchor by exactly the rendered scroll, leaving focus at the pointer', async () => {
  const v = await scene()
  try {
    v.ink.startTextSelection(0, 1)
    v.ink.handleSelectionDrag(6, 4)
    await settle()
    finishSelection(v.ink.selection)
    const painted = v.scroll.getElement()!.scrollTopRendered!
    expect(painted).toBeGreaterThan(0)
    expect(v.ink.selection.virtualAnchorRow).toBe(1 - painted)
    expect(v.ink.selection.focus).toEqual({ col: 6, row: 4 })
  } finally {
    v.close()
  }
})
test('actual transcript drag timer ignores a selection that belongs to an adjacent viewport', async () => {
  const v = await scene()
  try {
    v.ink.startTextSelection(20, 1)
    v.ink.handleSelectionDrag(27, 4)
    await settle()
    finishSelection(v.ink.selection)
    expect(v.scroll.getElement()!.scrollTopRendered).toBe(0)
    expect(v.ink.selection.anchor).toEqual({ col: 20, row: 1 })
  } finally {
    v.close()
  }
})
test('actual Shift Up at a scrolled viewport edge extends by the single painted row', async () => {
  const v = await scene()
  try {
    v.scroll.scrollTo(2)
    await settle()
    v.ink.startTextSelection(0, 0)
    updateSelection(v.ink.selection, 6, 0)
    finishSelection(v.ink.selection)
    expect(v.ink.getSelectedText()).toBe('left-02')
    await v.input('\x1b[1;2A')
    expect(v.scroll.getElement()!.scrollTopRendered).toBe(1)
    expect(v.ink.selection.anchor).toEqual({ col: 0, row: 1 })
    expect(v.ink.selection.focus).toEqual({ col: 6, row: 0 })
    expect(v.ink.getSelectedText()).toBe('1\nl')
  } finally {
    v.close()
  }
})
test('actual Shift Down does not move a fully hidden selection or scroll an adjacent viewport', async () => {
  const v = await scene()
  try {
    v.select()
    v.scroll.scrollTo(4)
    await settle()
    const before = { ...v.ink.selection, scope: undefined }
    await v.input('\x1b[1;2B')
    expect({ ...v.ink.selection, scope: undefined }).toEqual(before)
    expect(v.scroll.getElement()!.scrollTopRendered).toBe(4)
    v.ink.startTextSelection(20, 3)
    updateSelection(v.ink.selection, 27, 3)
    finishSelection(v.ink.selection)
    await v.input('\x1b[1;2B')
    expect(v.scroll.getElement()!.scrollTopRendered).toBe(4)
  } finally {
    v.close()
  }
})
test('actual Shift Down at the bottom extends through one painted row and keeps the full forward text', async () => {
  const v = await scene()
  try {
    v.ink.startTextSelection(0, 3)
    updateSelection(v.ink.selection, 6, 3)
    finishSelection(v.ink.selection)
    await v.input('\x1b[1;2B')
    expect(v.scroll.getElement()!.scrollTopRendered).toBe(1)
    expect(v.ink.selection.anchor).toEqual({ col: 0, row: 2 })
    expect(v.ink.selection.focus).toEqual({ col: 6, row: 3 })
    expect(v.ink.getSelectedText()).toBe('left-03\nleft-04')
  } finally {
    v.close()
  }
})

test('actual custom selection extend binding shares the scoped movement route', async () => {
  const v = await scene(12, [
    { context: 'Scroll', bindings: { 'ctrl+e': 'selection:extendRight' } },
  ])
  try {
    v.select()
    await v.input('\x05')
    expect(v.ink.hasTextSelection()).toBe(true)
    expect(v.ink.selection.focus).toEqual({ col: 7, row: 1 })
  } finally {
    v.close()
  }
})

// Official 2.1.292 fM reads VFe.peek(): a completed auto-copy clears on
// Ctrl+C, while a selection without an auto-copy still writes the clipboard.
for (const copyOnSelect of [undefined, true, false]) {
  test(`actual mouse release then Ctrl+C copies exactly once (copyOnSelect=${copyOnSelect})`, async () => {
    const original = config.getGlobalConfig()
    const setting = spyOn(config, 'getGlobalConfig').mockReturnValue({ ...original, copyOnSelect })
    const keys = ['SSH_CONNECTION', 'TMUX', 'STY'] as const
    const previous = keys.map(key => process.env[key])
    process.env.SSH_CONNECTION = 'selection-test'
    delete process.env.TMUX
    delete process.env.STY
    let v: Awaited<ReturnType<typeof scene>> | undefined
    try {
      v = await scene()
      await v.input('\x1b[<0;1;2M')
      await v.input('\x1b[<32;7;2M')
      await v.input('\x1b[<0;7;2m')
      // setClipboard awaits tmuxLoadBuffer before writing OSC52.
      await Promise.resolve()
      expect(v.ink.getSelectedText()).toBe('left-01')
      expect(v.output.copies()).toEqual(copyOnSelect === false ? [] : ['left-01'])
      await v.input('\x03')
      await Promise.resolve()
      expect(v.output.copies()).toEqual(['left-01'])
      expect(v.ink.hasTextSelection()).toBe(false)
    } finally {
      v?.close()
      setting.mockRestore()
      keys.forEach((key, i) => {
        if (previous[i] === undefined) delete process.env[key]
        else process.env[key] = previous[i]
      })
    }
  })
}

test('Ctrl+C uses the actual auto-copy receipt when the setting changes after mouse release', async () => {
  const original = config.getGlobalConfig()
  const setting = spyOn(config, 'getGlobalConfig').mockReturnValue({ ...original, copyOnSelect: true })
  const keys = ['SSH_CONNECTION', 'TMUX', 'STY'] as const
  const previous = keys.map(key => process.env[key])
  process.env.SSH_CONNECTION = 'selection-test'
  delete process.env.TMUX
  delete process.env.STY
  let v: Awaited<ReturnType<typeof scene>> | undefined
  try {
    v = await scene()
    await v.input('\x1b[<0;1;2M')
    await v.input('\x1b[<32;7;2M')
    await v.input('\x1b[<0;7;2m')
    await Promise.resolve()
    expect(v.output.copies()).toEqual(['left-01'])
    setting.mockReturnValue({ ...original, copyOnSelect: false })
    await v.input('\x03')
    await Promise.resolve()
    expect(v.output.copies()).toEqual(['left-01'])
    expect(v.ink.hasTextSelection()).toBe(false)
  } finally {
    v?.close()
    setting.mockRestore()
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key]
      else process.env[key] = previous[i]
    })
  }
})

test('Ctrl+C still copies a programmatic selection that did not auto-copy', async () => {
  const original = config.getGlobalConfig()
  const setting = spyOn(config, 'getGlobalConfig').mockReturnValue({ ...original, copyOnSelect: true })
  const keys = ['SSH_CONNECTION', 'TMUX', 'STY'] as const
  const previous = keys.map(key => process.env[key])
  process.env.SSH_CONNECTION = 'selection-test'
  delete process.env.TMUX
  delete process.env.STY
  let v: Awaited<ReturnType<typeof scene>> | undefined
  try {
    v = await scene()
    v.select()
    expect(v.output.copies()).toEqual([])
    await v.input('\x03')
    await Promise.resolve()
    expect(v.output.copies()).toEqual(['left-01'])
    expect(v.ink.hasTextSelection()).toBe(false)
  } finally {
    v?.close()
    setting.mockRestore()
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key]
      else process.env[key] = previous[i]
    })
  }
})
