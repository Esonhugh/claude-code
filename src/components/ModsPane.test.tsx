import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { isProxy } from 'node:util/types'
import { createModUiRealm } from '../services/mods/uiRealm.js'
import { resolveKeyWithChordState } from '../keybindings/resolver.js'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React, { useEffect, useSyncExternalStore } from 'react'
import stripAnsi from 'strip-ansi'
import chalk from 'chalk'
import { Box, Text, ThemeProvider, render, useInput, useStdin } from '../ink.js'
import { KeybindingProvider, useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { parseBindings } from '../keybindings/parser.js'
import type { KeybindingContextName, ParsedKeystroke } from '../keybindings/types.js'
import { appendChildNode, createNode, markDirty, type DOMElement, type DOMNode } from '../ink/dom.js'
import { getFocusManager } from '../ink/focus.js'
import instances from '../ink/instances.js'
import { nodeCache } from '../ink/node-cache.js'
import { dispatchClick } from '../ink/hit-test.js'
import { ModsPane, validateModRenderTree } from './ModsPane.js'
import { FullscreenLayout } from './FullscreenLayout.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { createModUi, type ModUiPane } from '../services/mods/ui.js'
import { AppStoreContext, getDefaultAppState } from '../state/AppState.js'
import { createStore } from '../state/store.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModsRuntime } from '../services/mods/runtime.js'
import type { ModClientHandle, ModClients } from '../services/mods/client.js'
import createRenderer from '../ink/renderer.js'
import { CharPool, createScreen, HyperlinkPool, StylePool } from '../ink/screen.js'
import type { Frame } from '../ink/frame.js'

class Output extends Writable {
  columns = 80
  rows = 30
  isTTY = false
  output = ''

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
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

function pane(tree: unknown, changes: Partial<ModUiPane> = {}): ModUiPane {
  return {
    id: 'test',
    title: 'Test',
    plugin: 'fixture',
    owner: {},
    visible: true,
    shown: true,
    placement: 'inline',
    focused: true,
    closeOnEscape: false,
    holdToasts: false,
    scrollOffset: 0,
    bodyRows: 10,
    bodyColumns: 76,
    revision: 0,
    contentRows: 10,
    tree,
    drawing: 7,
    ...changes,
  }
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 80))
}

function EnableInput(): null {
  const { setRawMode } = useStdin()
  useEffect(() => {
    setRawMode(true)
    return () => setRawMode(false)
  }, [setRawMode])
  return null
}

type InkInstance = {
  rootNode: DOMElement
  setAltScreenActive(active: boolean, mouseTracking?: boolean): void
  dispatchHover(col: number, row: number): void
}

type RenderedElement = {
  node: DOMElement
  text: string
}

function elements(stdout: Output, renderedOnly: boolean): RenderedElement[] {
  const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as InkInstance | undefined
  assert.ok(ink, 'Ink instance was not registered')
  const result: RenderedElement[] = []
  const textContent = (node: DOMNode): string => {
    if (node.nodeName === '#text') return node.nodeValue
    return node.childNodes.map(textContent).join('')
  }
  const visit = (node: DOMElement) => {
    if (!renderedOnly || nodeCache.has(node)) result.push({ node, text: textContent(node) })
    for (const child of node.childNodes) {
      if (child.nodeName !== '#text') visit(child)
    }
  }
  visit(ink.rootNode)
  return result
}

function deepestElement(stdout: Output, text: string, nodeName: DOMElement['nodeName'], renderedOnly = true): DOMElement {
  const matches = elements(stdout, renderedOnly).filter(element =>
    element.text === text && element.node.nodeName === nodeName,
  )
  assert.ok(matches.length > 0, `Expected a ${nodeName} with text ${JSON.stringify(text)}`)
  return matches.at(-1)!.node
}

function renderedElement(stdout: Output, text: string, nodeName: DOMElement['nodeName']): DOMElement {
  return deepestElement(stdout, text, nodeName)
}

function domElement(stdout: Output, text: string, nodeName: DOMElement['nodeName']): DOMElement {
  return deepestElement(stdout, text, nodeName, false)
}

function moveMouseTo(stdout: Output, node: DOMElement): void {
  const rect = nodeCache.get(node)
  assert.ok(rect, 'Expected target to have a rendered rect')
  const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as InkInstance | undefined
  assert.ok(ink, 'Ink instance was not registered')
  ink.setAltScreenActive(true, true)
  ink.dispatchHover(rect.x, rect.y)
}

function latestStyles(stdout: Output, texts: readonly string[]): Map<string, Record<string, unknown>> {
  return new Map(texts.map(text => [
    text,
    renderedElement(stdout, text, 'ink-text').textStyles as Record<string, unknown>,
  ]))
}

function modsPane(tree: unknown, stdout: Output) {
  return render(
    <ModsPane
      pane={pane(tree)}
      onInteract={async () => {}}
      onClose={async () => {}}
      onFocus={async () => ({})}
      onScroll={async () => ({})}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new Input() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
}

test.each([true, false])('Worker Markdown reaches the terminal Pane through runtime UI and the assistant renderer (dimColor=%s)', async dimColor => {
  const root = await mkdtemp(join(tmpdir(), 'mods-render-markdown-'))
  const diagnostics: unknown[] = []
  const runtime = createModsRuntime({
    onDiagnostic: event => diagnostics.push(event),
    services: { uiPresentation: () => ({ columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }) },
  })
  const stdout = new Output()
  const terminal = process.env.TERM_PROGRAM
  const colorLevel = chalk.level
  process.env.TERM_PROGRAM = 'kitty'
  chalk.level = 3
  let app: Awaited<ReturnType<typeof render>> | undefined
  try {
    const entry = join(root, 'register.ts')
    await writeFile(entry, `export function register(on) {
      on('session.start', async ($,e,next) => {await $.ui.open({id:'markdown'});return next(e)});
      on('ui.render', {component:'Pane'}, ($,e) => $.ui.resolve(e).Markdown({
        key:'reply', text:'# Render contract\\n\\n**Bold body** and \`inline code\`\\n\\n| Name | Value |\\n| --- | --- |\\n| phase | green |\\n| **Blocked table** | [**Label**](javascript:table) |\\n\\n[safe](https://example.com/) [**Unsafe label**](javascript:alert)', dimColor:${dimColor}
      }));
    }`)
    await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'markdown-test' })
    await runtime.reconcile([{ name: 'markdown', storageId: 'markdown@test', pluginRoot: root, entrypoints: [entry] }])
    expect(diagnostics).toEqual([])
    const current = runtime.ui.getSnapshot()[0]!
    expect(current.tree).toMatchObject({ type: 'Markdown', props: { key: 'reply', dimColor } })
    const state = { ...getDefaultAppState(), settings: { syntaxHighlightingDisabled: true } }
    expect(chalk.level).toBe(3)
    app = await render(<AppStoreContext.Provider value={createStore(state)}><ThemeProvider><ModsPane
      pane={current} onInteract={async () => {}} onClose={async () => {}} onFocus={async () => ({})} onScroll={async () => ({})}
    /></ThemeProvider></AppStoreContext.Provider>, {
      stdout: stdout as unknown as NodeJS.WriteStream, stdin: new Input() as unknown as NodeJS.ReadStream,
      patchConsole: false, exitOnCtrlC: false,
    })
    await settle()
    const output = stripAnsi(stdout.output)
    expect(output).toContain('Render contract')
    expect(output).toContain('Bold body')
    expect(output).toContain('inline code')
    expect(output).toContain('phase')
    expect(output).toContain('green')
    expect(output).not.toContain('**Bold body**')
    expect(output).not.toContain('| --- |')
    expect(output).toContain('Unsafe label')
    expect(output).not.toContain('**Unsafe label**')
    expect(output).toContain('Blocked table')
    expect(output).not.toContain('**Label**')
    const table = elements(stdout, false).filter(({node, text}) => node.nodeName === 'ink-text' && text.includes('phase')).at(-1)!
    expect(table.node.textStyles?.dim === true).toBe(dimColor)
    for (const label of ['Bold body', 'Unsafe label']) {
      const element = domElement(stdout, label, 'ink-virtual-text')
      expect(element.textStyles).toMatchObject(dimColor ? { dim: true } : { bold: true })
      if (dimColor) expect(element.textStyles?.bold).toBeUndefined()
    }
    const links = elements(stdout, false).filter(({node}) => node.nodeName === 'ink-link').map(({node}) => node.attributes.href)
    expect(links).toContain('https://example.com/')
    expect(links).not.toContain('javascript:alert')
    expect(links).not.toContain('javascript:table')
  } finally {
    if (terminal === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = terminal
    chalk.level = colorLevel
    app?.unmount()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

describe('ModsPane Markdown link presses', () => {
  test('only makes selected Markdown links pressable and sends the exact href to the drawing owner', async () => {
    const stdout = new Output()
    const terminal = process.env.TERM_PROGRAM
    const colorLevel = chalk.level
    process.env.TERM_PROGRAM = 'kitty'
    chalk.level = 3
    const pressed: unknown[][] = []
    const owner = {}
    const callback = { plugin: 'markdown-owner', handle: 31 }
    const store = createStore(getDefaultAppState())
    const current = pane({
      type: 'Markdown',
      props: {
        key: 'docs',
        text: '[handled](https://example.com/handled) [ordinary](https://example.com/ordinary)',
        pressableLinks: ['https://example.com/handled'],
      },
      press: callback,
    }, { owner })
    const draw = () => <AppStoreContext.Provider value={store}><ModsPane pane={current}
      onInteract={async (...args) => { pressed.push(args) }}
      onClose={async () => {}} onFocus={async () => ({})} onScroll={async () => ({})} />
    </AppStoreContext.Provider>
    const instance = await render(draw(), {
      stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      const handled = domElement(stdout, 'handled', 'ink-link')
      const control = handled
      expect(control.attributes.tabIndex).toBe(0)
      expect(elements(stdout, false).filter(({node}) => typeof node.attributes.tabIndex === 'number'))
        .toHaveLength(2) // pane root and the selected link
      expect(elements(stdout, false).filter(({node}) => node.nodeName === 'ink-link' && node.attributes.href !== undefined).map(({node}) => node.attributes.href))
        .toEqual(['https://example.com/ordinary'])

      const click = handled._eventHandlers!.onClick as (event: unknown) => void
      click({})
      await settle()
      expect(pressed).toEqual([[current, 7, callback, 'link.press', 'docs', 'https://example.com/handled']])
    } finally {
      instance.unmount()
      if (terminal === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = terminal
      chalk.level = colorLevel
    }
  })

  test('a detached Markdown link from an older drawing cannot fire', async () => {
    const stdout = new Output()
    const terminal = process.env.TERM_PROGRAM
    const colorLevel = chalk.level
    process.env.TERM_PROGRAM = 'kitty'
    chalk.level = 3
    const calls: unknown[][] = []
    const owner = {}
    const callback = { plugin: 'markdown-owner', handle: 32 }
    const store = createStore(getDefaultAppState())
    const markdown = (label: string) => ({
      type: 'Markdown', props: { key: 'docs', text: `[${label}](https://example.com/${label})` }, press: callback,
    })
    let current = pane(markdown('old'), { owner, drawing: 7 })
    const draw = () => <AppStoreContext.Provider value={store}><ModsPane pane={current} onInteract={async (...args) => { calls.push(args) }}
      onClose={async () => {}} onFocus={async () => ({})} onScroll={async () => ({})} />
    </AppStoreContext.Provider>
    const instance = await render(draw(), {
      stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      const oldControl = domElement(stdout, 'old', 'ink-link')
      const staleClick = oldControl._eventHandlers!.onClick as (event: unknown) => void
      current = pane(markdown('new'), { owner, drawing: 8, revision: 1 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      staleClick({})
      await settle()
      expect(calls).toEqual([])
    } finally {
      instance.unmount()
      if (terminal === undefined) delete process.env.TERM_PROGRAM
      else process.env.TERM_PROGRAM = terminal
      chalk.level = colorLevel
    }
  })
})

describe('ModsPane validation', () => {
  test('accepts the terminal element table and rejects unknown props, malformed callbacks and oversized trees', () => {
    expect(() => validateModRenderTree({
      type: 'Box', props: { flexDirection: 'column', gap: 1 }, children: [
        { type: 'Text', props: { bold: true }, children: ['hello'] },
        { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 9 } },
        { type: 'Select', props: { key: 'base', options: [{ value: 'main', label: 'Main' }] }, press: { plugin: 'fixture', handle: 10 } },
        { type: 'Code', props: { source: 'const ok = true', language: 'typescript' } },
      ],
    })).not.toThrow()
    expect(() => validateModRenderTree({ type: 'Box', props: { position: 'fixed' } })).toThrow(/position/i)
    expect(() => validateModRenderTree({ type: 'Button', props: { key: 'x', label: 'X' }, press: { plugin: 'fixture', handle: 0 } })).toThrow(/handle/i)
    expect(() => validateModRenderTree({ type: 'Code', props: { source: 'x'.repeat(10_001) } })).toThrow(/10000/i)
    expect(() => validateModRenderTree({ type: 'Code', props: { source: 'not a patch', format: 'diff' } })).toThrow(/hunk/i)
    expect(() => validateModRenderTree({ type: 'Text', children: ['\u001b[31mraw ansi'] })).toThrow(/control/i)
    expect(() => validateModRenderTree({ type: 'Box', children: Array.from({ length: 2_001 }, () => 'x') })).toThrow(/node/i)
  })

  test('accepts official Raster and Image leaves and validates their bounded payloads', () => {
    const cells = Buffer.alloc(12)
    cells.writeUInt32LE('A'.charCodeAt(0), 0)
    cells.writeUInt32LE(0x00ff0000, 4)
    cells.writeUInt32LE(0x01000000, 8)
    const raster = {
      type: 'Raster',
      props: { key: 'pixels', columns: 1, rows: 1, cells: cells.toString('base64') },
      group: { plugin: 'fixture' },
    }
    const image = {
      type: 'Image',
      props: {
        key: 'preview', columns: 8, rows: 4, alt: 'preview unavailable',
        source: { rgba: Buffer.alloc(4).toString('base64'), width: 1, height: 1 },
      },
      group: { plugin: 'fixture' },
    }
    expect(() => validateModRenderTree({ type: 'Box', children: [raster, image] })).not.toThrow()
    expect(() => validateModRenderTree({ ...raster, props: { ...raster.props, cells: 'AA==' } })).toThrow(/cells|length/i)
    expect(() => validateModRenderTree({ ...raster, props: { ...raster.props, columns: 513 } })).toThrow(/columns/i)
    expect(() => validateModRenderTree({ ...image, props: { ...image.props, source: { png: 'not base64' } } })).toThrow(/base64/i)
    expect(() => validateModRenderTree({ ...image, props: { ...image.props, source: { file: '/tmp/image.png', format: 'rgb' } } })).toThrow(/width|height|format/i)
    expect(() => validateModRenderTree({ ...image, children: ['forged'] })).toThrow(/leaf/i)
  })

  test('rejects Button hotkeys outside digits/lowercase letters and unknown engine actions', () => {
    for (const hotkey of ['', 'W', '!', 'é', 'ab']) {
      expect(() => validateModRenderTree({ ...fileButton('bad'), props: { key: 'bad', label: 'Bad', hotkey } })).toThrow(/hotkey/i)
    }
    for (const action of ['', 'app:notAnEngineAction']) {
      expect(() => validateModRenderTree({ ...fileButton('bad'), props: { key: 'bad', label: 'Bad', action } })).toThrow(/action/i)
    }
  })

  test.each(['Button', 'Select', 'Input'])('accepts full-path %s keys within the existing UI string budget', type => {
    const tree = (key: string) => ({
      type,
      props: { key, ...(type === 'Button' ? { label: 'File' } : type === 'Select' ? { options: [{ value: 'HEAD' }] } : {}) },
      press: { plugin: 'fixture', handle: 1 },
    })
    for (const key of [`file:${'nested/'.repeat(24)}source.ts`, `file:${'目录/'.repeat(28)}文件.ts`, 'x'.repeat(10_000)]) {
      const validated = validateModRenderTree(tree(key))
      expect(validated.tree.props?.key).toBe(key)
      expect(validated.focusKeys.has(key)).toBe(true)
    }
    expect(() => validateModRenderTree(tree('x'.repeat(10_001)))).toThrow(/10000/)
    for (const key of ['file:bad\npath', 'file:bad\u001bpath']) {
      expect(() => validateModRenderTree(tree(key))).toThrow(/control/)
    }
  })

  test('enforces safe link URLs, inline ancestry and select contracts', () => {
    expect(() => validateModRenderTree({ type: 'Link', props: { href: 'https://example.com/path' }, children: ['safe'] })).not.toThrow()
    expect(() => validateModRenderTree({
      type: 'Text',
      children: [{
        type: 'Link',
        props: { href: 'https://example.com/path' },
        children: [{ type: 'Box', children: ['block'] }],
      }],
    })).toThrow(/Box.*inline/i)
    expect(() => validateModRenderTree({
      type: 'Link',
      props: { href: 'https://example.com/path' },
      children: [{ type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 1 } }],
    })).toThrow(/Button.*inline/i)
    for (const href of ['file:///tmp/x', 'https://user@example.com', 'https://example.com/raw path', 'https://é.example']) {
      expect(() => validateModRenderTree({ type: 'Link', props: { href } })).toThrow(/href/i)
    }
    expect(() => validateModRenderTree({
      type: 'Select',
      props: { key: 'dup', options: [{ value: 'x' }, { value: 'x' }] },
      press: { plugin: 'fixture', handle: 1 },
    })).toThrow(/unique/i)
    expect(() => validateModRenderTree({
      type: 'Select', props: { key: 'empty', options: [] }, press: { plugin: 'fixture', handle: 1 },
    })).toThrow(/must contain 1-/i)
    expect(() => validateModRenderTree({
      type: 'Select', props: { key: 'missing', value: 'gone', options: [{ value: 'main' }] }, press: { plugin: 'fixture', handle: 1 },
    })).toThrow(/must name an option/i)
  })

  test('requires unscoped hover styles and display to live in a visible unique keyed Box', () => {
    expect(() => validateModRenderTree({
      type: 'Box',
      props: { key: 'row' },
      children: [{ type: 'Text', children: ['label'], hover: { bold: true } }],
    })).not.toThrow()
    expect(() => validateModRenderTree({
      type: 'Box',
      props: { key: 'row' },
      children: [{ type: 'Box', props: { display: 'none' }, hover: { display: 'flex' } }],
    })).not.toThrow()
    expect(() => validateModRenderTree({
      type: 'Box',
      props: { key: 'hidden', display: 'none' },
      children: [{ type: 'Text', children: ['label'], hover: { bold: true } }],
    })).toThrow(/visible unique keyed Box/i)
    expect(() => validateModRenderTree({
      type: 'Box',
      props: { display: 'none' },
      children: [{
        type: 'Box',
        props: { key: 'hidden-child' },
        children: [{ type: 'Text', children: ['label'], hover: { bold: true } }],
      }],
    })).toThrow(/visible unique keyed Box/i)
    for (const key of ['', 17, 'bad\nkey', 'x'.repeat(10_001), { nested: true }]) {
      const validated = validateModRenderTree({
        type: 'Box',
        props: { key },
        children: [{ type: 'Text', children: ['label'], hover: { bold: true } }],
      })
      expect(validated.tree.props?.key).toBeUndefined()
    }
    for (const key of ['x'.repeat(65), 'x'.repeat(10_000)]) {
      const validated = validateModRenderTree({
        type: 'Box',
        props: { key },
        children: [{ type: 'Text', children: ['label'], hover: { bold: true } }],
      })
      expect(validated.tree.props?.key).toBe(key)
    }
    expect(() => validateModRenderTree({
      type: 'Box',
      children: [
        { type: 'Box', props: { key: 'duplicate' }, children: [{ type: 'Text', children: ['one'], hover: { bold: true } }] },
        { type: 'Box', props: { key: 'duplicate' }, children: [{ type: 'Text', children: ['two'], hover: { italic: true } }] },
      ],
    })).not.toThrow()
    expect(() => validateModRenderTree({
      type: 'Box',
      props: { key: 'row' },
      children: [{
        type: 'Text',
        children: ['label'],
        hover: { scope: 'orphan', bold: true },
      }],
    })).toThrow(/plugin|group/i)
    expect(() => validateModRenderTree({
      type: 'Text',
      children: ['label'],
      hover: { bold: true },
    })).toThrow(/keyed Box/i)
    expect(() => validateModRenderTree({
      type: 'Box',
      hover: { display: 'flex' },
    })).toThrow(/keyed Box/i)
    expect(() => validateModRenderTree({
      type: 'Box',
      hover: { scope: 'shared', display: 'flex' },
      group: { plugin: 'owner' },
    })).toThrow(/display.*none/i)
    expect(() => validateModRenderTree({
      type: 'Text',
      children: ['label'],
      hover: { scope: 'shared', bold: true },
      group: { plugin: '' },
    })).toThrow(/plugin/i)
  })
})

describe.serial('ModsPane terminal Image consumer', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
  const image = (source: Record<string, unknown>, changes: Record<string, unknown> = {}) => ({
    type: 'Image',
    props: { key: 'preview', source, columns: 8, rows: 4, alt: 'preview unavailable', ...changes },
    group: { plugin: 'fixture' },
  })
  let ttyDescriptor: PropertyDescriptor | undefined
  let termProgram: string | undefined

  beforeEach(() => {
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    termProgram = process.env.TERM_PROGRAM
  })

  afterEach(() => {
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor)
    else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY
    if (termProgram === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = termProgram
  })

  test('keeps the alt fallback on unsupported and non-TTY terminals without leaking image bytes', async () => {
    for (const [isTTY, terminal] of [[false, 'kitty'], [true, 'iTerm.app']] as const) {
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: isTTY })
      process.env.TERM_PROGRAM = terminal
      const stdout = new Output()
      stdout.isTTY = isTTY
      const instance = await modsPane(image({ png }), stdout)
      try {
        await settle()
        expect(stripAnsi(stdout.output)).toContain('preview')
        expect(stdout.output).not.toContain(png)
        expect(stdout.output).not.toContain('\u001b_G')
      } finally { instance.unmount() }
    }
  })

  test('uses the configured output TTY instead of global process.stdout', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true
    const instance = await modsPane(image({ png }), stdout)
    try {
      await settle()
      expect(stdout.output).toContain('\u001b_Ga=T,f=100,t=d,c=8,r=4,C=1')
      expect(stripAnsi(stdout.output)).not.toContain('preview unavailable')
    } finally { instance.unmount() }
  })

  test('emits Kitty protocol for inline, regular-file and POSIX shm sources without reading them', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    process.env.TERM_PROGRAM = 'ghostty'
    const cases = [
      [{ png }, 'f=100,t=d'],
      [{ rgba: Buffer.from([1, 2, 3, 4]).toString('base64'), width: 1, height: 1 }, 'f=32,s=1,v=1,t=d'],
      [{ file: '/missing/chart.png', format: 'png' }, 'f=100,t=f'],
      [{ file: '/missing/frame.rgb', format: 'rgb', width: 2, height: 3 }, 'f=24,s=2,v=3,t=f'],
      [{ file: '/missing/frame.rgba', format: 'rgba', width: 2, height: 3 }, 'f=32,s=2,v=3,t=f'],
      [{ shm: '/mods-rgb', format: 'rgb', width: 2, height: 3 }, 'f=24,s=2,v=3,t=s'],
      [{ shm: '/mods-rgba', format: 'rgba', width: 2, height: 3 }, 'f=32,s=2,v=3,t=s'],
    ] as const
    for (const [source, transmission] of cases) {
      const stdout = new Output()
      stdout.isTTY = true
      const instance = await modsPane(image(source), stdout)
      try {
        await settle()
        expect(stdout.output).toContain(`\u001b_Ga=T,${transmission},c=8,r=4,C=1`)
        expect(stripAnsi(stdout.output)).not.toContain('preview unavailable')
        if ('file' in source) expect(stdout.output).toContain(Buffer.from(source.file).toString('base64'))
        if ('shm' in source) expect(stdout.output).toContain(Buffer.from(source.shm).toString('base64'))
      } finally { instance.unmount() }
    }
  })

  test('suppresses ordinary equal sources, includes generation in identity, and emits every shm frame', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true
    const owner = {}
    const file = { file: '/missing/frame.rgb', format: 'rgb', width: 1, height: 1, generation: 1 } as const
    const shm = { shm: '/mods-once', format: 'rgba', width: 1, height: 1 } as const
    let current = pane(image(file), { owner })
    const draw = () => <ModsPane pane={current} onInteract={async () => {}} onClose={async () => {}}
      onFocus={async () => ({})} onScroll={async () => ({})} />
    const instance = await render(<ThemeProvider>{draw()}</ThemeProvider>, { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await new Promise(resolve => setTimeout(resolve, 250))
      current = pane(image(file), { owner, revision: 1 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await new Promise(resolve => setTimeout(resolve, 250))
      stdout.output = ''
      const count = () => stdout.output.split('\u001b_Ga=T,').length - 1
      let frames = count()
      current = pane(image(file), { owner, revision: 2 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(count()).toBe(frames)
      current = pane(image({ file: '/missing/frame.rgb', format: 'rgb', width: 1, height: 1, generation: 2 }), { owner, revision: 3 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(count()).toBe(++frames)

      current = pane(image(shm), { owner, revision: 3 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(count()).toBe(++frames)
      current = pane(image({ ...shm }), { owner, revision: 4 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(count()).toBe(++frames)
    } finally { instance.unmount() }
  })

  test('places the image at its actual Ink layout coordinates', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true
    const instance = await modsPane({
      type: 'Box',
      props: { paddingLeft: 3, paddingTop: 2 },
      children: [image({ png })],
    }, stdout)
    try {
      await settle()
      expect(stdout.output).toContain('\u001b[3;4H\u001b_Ga=T,')
    } finally { instance.unmount() }
  })

  test('crops clipped image source pixels instead of scaling the complete source', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true
    const partial = await modsPane({
      type: 'Box',
      props: { width: 4, height: 2, overflow: 'hidden' },
      children: [{
        type: 'Box',
        props: { width: 10, height: 8, flexShrink: 0 },
        children: [image({ rgba: Buffer.alloc(100 * 80 * 4).toString('base64'), width: 100, height: 80 }, { columns: 10, rows: 8 })],
      }],
    }, stdout)
    try {
      await settle()
      expect(stdout.output).toContain('t=d,x=0,y=0,w=40,h=20,c=4,r=2,C=1')
    } finally { partial.unmount() }
  })

  test('does not scale clipped PNG files with unknown pixel dimensions', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true
    const partial = await modsPane({
      type: 'Box',
      props: { width: 4, height: 2, overflow: 'hidden' },
      children: [{
        type: 'Box',
        props: { width: 10, height: 8, flexShrink: 0 },
        children: [image({ file: '/missing/chart.png', format: 'png' }, { columns: 10, rows: 8 })],
      }],
    }, stdout)
    try {
      await settle()
      expect(stdout.output).not.toContain('\u001b_Ga=T,')
    } finally { partial.unmount() }
  })

  test('does not place fully clipped images', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true

    stdout.output = ''
    const hidden = await modsPane({
      type: 'Box',
      props: { width: 6, height: 2, overflow: 'hidden' },
      children: [{
        type: 'Box',
        props: { marginTop: 3 },
        children: [image({ png }, { columns: 6, rows: 4 })],
      }],
    }, stdout)
    try {
      await settle()
      expect(stdout.output).not.toContain('\u001b_Ga=T,')
    } finally { hidden.unmount() }
  })

  test('deletes the old Kitty image before replacement and on unmount', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true
    const owner = {}
    let current = pane(image({ file: '/missing/first.png', format: 'png' }), { owner })
    const draw = () => <ModsPane pane={current} onInteract={async () => {}} onClose={async () => {}}
      onFocus={async () => ({})} onScroll={async () => ({})} />
    const instance = await render(<ThemeProvider>{draw()}</ThemeProvider>, { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdout.output = ''
      current = pane(image({ file: '/missing/second.png', format: 'png' }), { owner, revision: 1 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      const deletion = stdout.output.indexOf('\u001b_Ga=d,d=i,i=')
      const replacement = stdout.output.indexOf('\u001b_Ga=T,')
      expect(deletion).toBeGreaterThanOrEqual(0)
      expect(replacement).toBeGreaterThan(deletion)
      stdout.output = ''
      instance.unmount()
      expect(stdout.output).toContain('\u001b_Ga=d,d=i,i=')
    } finally { instance.unmount() }
  })

  test('delivers burst shm pane blits through the external store and Ink output', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true
    const owner = { plugin: 'fixture' }
    const ui = createModUi({
      pluginOf: current => (current as { plugin: string }).plugin,
      dispatch: async (_owner, _event, input, core) => core(input),
      draw: async () => image({ shm: '/initial', format: 'rgb', width: 1, height: 1 }, { columns: 1, rows: 1 }),
      invokeDrawing: async () => undefined,
      releaseDrawing: async () => {},
    })
    await ui.open(owner, { id: 'pane' }, { kind: 'person' }, {
      columns: 80,
      rows: 30,
      isFullscreen: false,
      composerEmpty: true,
      hasDialog: false,
      keyboardOwned: false,
    })
    await ui.commit(owner)

    function Consumer() {
      const current = useSyncExternalStore(ui.subscribe, ui.getSnapshot)
      return current[0]
        ? <ModsPane pane={current[0]} onInteract={async () => {}} onClose={async () => {}}
          onFocus={async () => ({})} onScroll={async () => ({})} />
        : null
    }

    const instance = await render(<ThemeProvider><Consumer /></ThemeProvider>, {
      stdout: stdout as never,
      stdin: new Input() as never,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    try {
      await settle()
      stdout.output = ''
      const first = ui.blit(owner, {
        requestId: 'pane', key: 'preview',
        source: { shm: '/frame-1', format: 'rgb', width: 1, height: 1 },
      })
      const second = ui.blit(owner, {
        requestId: 'pane', key: 'preview',
        source: { shm: '/frame-2', format: 'rgb', width: 1, height: 1 },
      })
      await Promise.all([first, second])
      await settle()
      expect(stdout.output).toContain(Buffer.from('/frame-1').toString('base64'))
      expect(stdout.output).toContain(Buffer.from('/frame-2').toString('base64'))
    } finally {
      instance.unmount()
      await ui.dispose()
    }
  })

  test('keeps a mounted terminal image in the frame when only a sibling is dirty', () => {
    const stylePool = new StylePool()
    const charPool = new CharPool()
    const hyperlinkPool = new HyperlinkPool()
    const root = createNode('ink-root')
    const imageNode = createNode('ink-box')
    const sibling = createNode('ink-box')
    root.yogaNode?.setWidth(8)
    imageNode.yogaNode?.setWidth(4)
    imageNode.yogaNode?.setHeight(2)
    sibling.yogaNode?.setWidth(4)
    sibling.yogaNode?.setHeight(1)
    imageNode.terminalImage = {
      id: 77,
      identity: 'stable',
      sequences: () => [],
    }
    appendChildNode(root, imageNode)
    appendChildNode(root, sibling)
    root.yogaNode?.calculateLayout(8)

    const empty = (): Frame => ({
      screen: createScreen(8, 3, stylePool, charPool, hyperlinkPool),
      viewport: { width: 8, height: 30 },
      cursor: { x: 0, y: 0, visible: true },
    })
    const renderFrame = createRenderer(root, stylePool)
    const first = renderFrame({
      frontFrame: empty(),
      backFrame: empty(),
      isTTY: true,
      terminalWidth: 8,
      terminalRows: 30,
      altScreen: false,
      prevFrameContaminated: false,
    })
    expect(first.terminalImages?.map(entry => entry.id)).toEqual([77])

    markDirty(sibling)
    root.yogaNode?.calculateLayout(8)
    const second = renderFrame({
      frontFrame: first,
      backFrame: empty(),
      isTTY: true,
      terminalWidth: 8,
      terminalRows: 30,
      altScreen: false,
      prevFrameContaminated: false,
    })
    expect(imageNode.dirty).toBeFalse()
    expect(second.terminalImages?.map(entry => entry.id)).toEqual([77])
  })

  test('chunks direct payloads at no more than 4096 base64 characters', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    process.env.TERM_PROGRAM = 'kitty'
    const stdout = new Output()
    stdout.isTTY = true
    const rgba = Buffer.alloc(32 * 32 * 4, 7).toString('base64')
    const instance = await modsPane(image({ rgba, width: 32, height: 32 }), stdout)
    try {
      await settle()
      const payloads = stdout.output.split('\u001b_G').slice(1)
        .filter(sequence => sequence.startsWith('a=T,') || sequence.startsWith('m='))
        .map(sequence => sequence.slice(sequence.indexOf(';') + 1, sequence.indexOf('\u001b\\')))
      expect(payloads.length).toBeGreaterThan(1)
      expect(payloads.every(payload => payload.length <= 4096)).toBe(true)
      expect(payloads.join('')).toBe(rgba)
    } finally { instance.unmount() }
  })
})

describe('ModsPane Client consumer', () => {
  function clientNode(
    props: Record<string, unknown> = {},
    plugin = 'fixture',
  ): Record<string, unknown> {
    return {
      type: 'Client',
      props: { key: 'chart', module: './chart.tsx', ...props },
      group: { plugin },
    }
  }

  function clientHost(options: {
    mount?: (pane: ModUiPane, node: unknown, commit: (tree: unknown) => void) => void
  } = {}): {
    clients: ModClients
    calls: {
      mounts: { pane: ModUiPane; node: unknown; commit: (tree: unknown) => void }[]
      updates: { pane: ModUiPane; node: unknown }[]
      resizes: [number, number][]
      pointers: unknown[]
      keys: unknown[]
      presses: unknown[][]
      disposes: number
    }
  } {
    const calls = {
      mounts: [] as { pane: ModUiPane; node: unknown; commit: (tree: unknown) => void }[],
      updates: [] as { pane: ModUiPane; node: unknown }[],
      resizes: [] as [number, number][],
      pointers: [] as unknown[],
      keys: [] as unknown[],
      presses: [] as unknown[][],
      disposes: 0,
    }
    const clients: ModClients = {
      reconcile() {},
      mount(current, node, commit) {
        calls.mounts.push({ pane: current, node, commit })
        options.mount?.(current, node, commit)
        const handle: ModClientHandle = {
          ready: Promise.resolve(),
          async update(nextPane, nextNode) { calls.updates.push({ pane: nextPane, node: nextNode }) },
          async resize(columns, rows) { calls.resizes.push([columns, rows]) },
          async pointer(event) { calls.pointers.push(event) },
          async key(event) { calls.keys.push(event) },
          async press(...args) { calls.presses.push(args); return undefined },
          async dispose() { calls.disposes++ },
        }
        return handle
      },
    }
    return { clients, calls }
  }

  function paneWithClients(tree: unknown, clients: ModClients, changes: Partial<ModUiPane> = {}): ModUiPane {
    return Object.assign(pane(tree, changes), { clients })
  }

  test('validates a strict Client leaf with bounded plain JSON props and layout', () => {
    expect(() => validateModRenderTree(clientNode({
      props: { nested: [null, true, 3, 'ok', { value: 'plain' }] },
      width: '50%', height: 4, flexGrow: 1,
    }))).not.toThrow()
    for (const value of [
      { ...clientNode(), children: [] },
      { ...clientNode(), press: { plugin: 'fixture', handle: 1 } },
      clientNode({ extra: true }),
      clientNode({ key: '' }),
      clientNode({ module: '' }),
      clientNode({ width: -1 }),
      clientNode({ height: 'wide' }),
      clientNode({ flexGrow: Number.POSITIVE_INFINITY }),
      clientNode({ props: { bad: undefined } }),
      clientNode({ props: new Date() }),
      clientNode({ props: 'x'.repeat(1_000_001) }),
    ]) expect(() => validateModRenderTree(value)).toThrow()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => validateModRenderTree(clientNode({ props: cyclic }))).toThrow(/plain JSON/i)
    expect(() => validateModRenderTree({ type: 'Box', children: [clientNode(), clientNode()] })).toThrow(/unique/i)
  })

  test('mounts, updates and disposes a keyed Client while its committed child changes', async () => {
    const stdout = new Output()
    const host = clientHost({ mount: (_pane, _node, commit) => {
      commit({ type: 'Text', children: ['first client frame'] })
    } })
    const owner = {}
    let current = paneWithClients(clientNode({ props: { value: 1 } }), host.clients, { owner })
    const draw = () => <ModsPane pane={current}
      onInteract={async () => { throw new Error('Client callbacks must not use pane drawing') }}
      onClose={async () => {}} onFocus={async () => ({})} onScroll={async () => ({})} />
    const instance = await render(draw(), {
      stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      expect(stripAnsi(stdout.output)).toContain('first client frame')
      expect(host.calls.mounts).toHaveLength(1)
      host.calls.mounts[0]!.commit({ type: 'Text', children: ['second client frame'] })
      await settle()
      expect(stripAnsi(stdout.output)).toContain('second client frame')

      current = paneWithClients(clientNode({ props: { value: 2 } }), host.clients, { owner, revision: 1 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(host.calls.mounts).toHaveLength(1)
      expect(host.calls.updates).toHaveLength(1)
      expect(host.calls.updates[0]!.node).toMatchObject({ props: { props: { value: 2 } } })

      current = paneWithClients(clientNode({ module: './other.tsx' }), host.clients, { owner, revision: 2 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(host.calls.mounts).toHaveLength(2)
      expect(host.calls.disposes).toBe(1)
    } finally {
      instance.unmount()
      await settle()
    }
    expect(host.calls.disposes).toBe(2)
  })

  test('reports one host-owned ready rejection', async () => {
    const stdout = new Output()
    const errors: unknown[] = []
    const failure = new Error('Client module failed')
    const clients: ModClients = {
      reconcile() {},
      mount(_pane, _node, _commit, onError) {
        const ready = Promise.reject(failure)
        void ready.catch(error => onError?.(error))
        return {
          ready,
          async update() {}, async resize() {}, async pointer() {}, async key() {},
          async press() {}, async dispose() {},
        }
      },
    }
    const instance = await render(<ModsPane pane={paneWithClients(clientNode(), clients)}
      onInteract={async () => {}} onClose={async () => {}} onFocus={async () => ({})}
      onScroll={async () => ({})} onError={error => errors.push(error)} />, {
      stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      expect(errors).toEqual([failure])
    } finally { instance.unmount() }
  })

  test('keeps sibling Client instances by plugin, key and module when keyed siblings move', async () => {
    const stdout = new Output()
    const host = clientHost({ mount: (_pane, raw, commit) => {
      const node = raw as { props: { key: string } }
      commit({ type: 'Text', children: [`frame ${node.props.key}`] })
    } })
    const owner = {}
    const tree = (keys: string[]) => ({
      type: 'Box', props: { flexDirection: 'column' },
      children: keys.map(key => clientNode({ key })),
    })
    let current = paneWithClients(tree(['a', 'b']), host.clients, { owner })
    const draw = () => <ModsPane pane={current} onInteract={async () => {}}
      onClose={async () => {}} onFocus={async () => ({})} onScroll={async () => ({})} />
    const instance = await render(draw(), {
      stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      current = paneWithClients(tree(['b', 'a']), host.clients, { owner, revision: 1 })
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(host.calls.mounts).toHaveLength(2)
      expect(host.calls.disposes).toBe(0)
      expect(host.calls.updates).toHaveLength(2)
    } finally { instance.unmount() }
  })

  test('routes real Client layout, raw pointer focus, keys and local controls through the mounted handle', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const errors: unknown[] = []
    const host = clientHost({ mount: (_pane, _node, commit) => {
      commit({
        type: 'Box', props: { flexDirection: 'column' }, children: [
          { type: 'Text', children: ['client canvas'] },
          { type: 'Button', props: { key: 'client-button', label: 'Run' }, press: { plugin: 'fixture', handle: 41 } },
          { type: 'Input', props: { key: 'client-input', placeholder: 'type' }, press: { plugin: 'fixture', handle: 42 } },
          { type: 'Select', props: { key: 'client-select', options: [{ value: 'one' }, { value: 'two' }] }, press: { plugin: 'fixture', handle: 43 } },
        ],
      })
    } })
    const current = paneWithClients(clientNode({ width: 24, height: 7 }), host.clients, { focusedElement: 'chart' })
    const instance = await render(<><EnableInput /><ModsPane pane={current}
      onInteract={async () => { throw new Error('Client callbacks must not use pane drawing') }}
      onClose={async () => {}} onFocus={async (_pane, element) => ({ focused: true, element })}
      onScroll={async () => ({})} onError={error => errors.push(error)} /></>, {
      stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      expect(host.calls.resizes).toContainEqual([24, 7])
      const canvas = renderedElement(stdout, 'client canvas', 'ink-text')
      const rect = nodeCache.get(canvas)!
      const ink = instances.get(stdout as never) as unknown as InkInstance
      ink.setAltScreenActive(true, true)
      stdin.push(`\u001b[<0;${rect.x + 1};${rect.y + 1}M`)
      await settle()
      expect(host.calls.pointers).toEqual([{ type: 'down', x: 0, y: 0, button: 'left' }])
      stdin.push(`\u001b[<0;${rect.x + 1};${rect.y + 1}m`)
      await settle()
      expect(host.calls.pointers).toEqual([{ type: 'down', x: 0, y: 0, button: 'left' }, { type: 'up', x: 0, y: 0, button: 'left' }])
      expect(getFocusManager(canvas).activeElement).toBe(canvas.parentNode!.parentNode!)
      stdin.push('x')
      await settle()
      expect(host.calls.keys).toEqual([{ key: 'x' }])
      stdin.push('\u001b')
      await settle()
      expect(host.calls.keys).toHaveLength(1)

      const button = renderedElement(stdout, '[ Run ]', 'ink-text').parentNode!
      const pointerCount = host.calls.pointers.length
      const keyCount = host.calls.keys.length
      const buttonRect = nodeCache.get(button)!
      stdin.push(`\u001b[<0;${buttonRect.x + 1};${buttonRect.y + 1}M`)
      stdin.push(`\u001b[<0;${buttonRect.x + 1};${buttonRect.y + 1}m`)
      await settle()
      expect(host.calls.pointers).toHaveLength(pointerCount)
      stdin.push('z')
      await settle()
      expect(host.calls.keys).toHaveLength(keyCount)
      const input = renderedElement(stdout, 'type', 'ink-text').parentNode!
      getFocusManager(input).focus(input)
      stdin.push('a\r')
      await settle()
      const select = renderedElement(stdout, 'one ↑↓', 'ink-text').parentNode!
      getFocusManager(select).focus(select)
      stdin.push('\u001b[B\r')
      await settle()
      expect(host.calls.presses).toEqual([
        [{ plugin: 'fixture', handle: 41 }, 'press', 'client-button'],
        [{ plugin: 'fixture', handle: 42 }, 'input.change', 'client-input', 'a'],
        [{ plugin: 'fixture', handle: 42 }, 'input.submit', 'client-input', 'a'],
        [{ plugin: 'fixture', handle: 43 }, 'select', 'client-select', 'two'],
      ])
      expect(errors).toEqual([])
    } finally { instance.unmount() }
  })

  test('captures real pointer drags past Client edges until release and clears capture on unmount', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const host = clientHost({ mount: (_pane, _node, commit) => {
      commit({ type: 'Text', children: ['capture canvas'] })
    } })
    const other = clientHost({ mount: (_pane, _node, commit) => {
      commit({ type: 'Text', children: ['other canvas'] })
    } })
    const first = paneWithClients(clientNode({ width: 16, height: 2 }), host.clients)
    const second = paneWithClients(clientNode({ key: 'other', width: 16, height: 2 }), other.clients, { placement: 'dock' })
    const scrolls: number[] = []
    const draw = (showFirst = true) => <><EnableInput />
      {showFirst && <ModsPane pane={first} onInteract={async () => {}} onClose={async () => {}}
        onFocus={async (_pane, element) => ({ focused: true, element })}
        onScroll={async (_pane, by) => { scrolls.push(by) }} />}
      <ModsPane pane={second} onInteract={async () => {}} onClose={async () => {}}
        onFocus={async (_pane, element) => ({ focused: true, element })}
        onScroll={async (_pane, by) => { scrolls.push(by) }} />
    </>
    const instance = await render(draw(), {
      stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      const ink = instances.get(stdout as never) as unknown as InkInstance
      ink.setAltScreenActive(true, true)
      const a = nodeCache.get(renderedElement(stdout, 'capture canvas', 'ink-text'))!
      const b = nodeCache.get(renderedElement(stdout, 'other canvas', 'ink-text'))!
      stdin.push(`\u001b[<2;${a.x + 1};${a.y + 1}M`)
      stdin.push(`\u001b[<34;${b.x + 1};${b.y + 1}M`)
      stdin.push(`\u001b[<65;${b.x + 1};${b.y + 1}M`)
      await settle()
      expect(host.calls.pointers).toEqual([
        { type: 'down', x: 0, y: 0, button: 'right' },
        { type: 'leave', x: 0, y: 0 },
        { type: 'move', x: b.x - a.x, y: b.y - a.y, button: 'right' },
      ])
      expect(other.calls.pointers).toEqual([])
      expect(scrolls).toEqual([])
      stdin.push(`\u001b[<2;${b.x + 1};${b.y + 1}m`)
      await settle()
      expect(host.calls.pointers.at(-1)).toEqual({ type: 'up', x: b.x - a.x, y: b.y - a.y, button: 'right' })
      stdin.push(`\u001b[<1;${a.x + 1};${a.y + 1}M`)
      await settle()
      const beforeUnmount = host.calls.pointers.length
      instance.rerender(<ThemeProvider>{draw(false)}</ThemeProvider>)
      await settle()
      const remaining = nodeCache.get(renderedElement(stdout, 'other canvas', 'ink-text'))!
      stdin.push(`\u001b[<0;${remaining.x + 1};${remaining.y + 1}M`)
      stdin.push(`\u001b[<0;${remaining.x + 1};${remaining.y + 1}m`)
      await settle()
      expect(host.calls.disposes).toBe(1)
      expect(host.calls.pointers).toHaveLength(beforeUnmount)
      expect(other.calls.pointers).toEqual([
        { type: 'down', x: 0, y: 0, button: 'left' },
        { type: 'up', x: 0, y: 0, button: 'left' },
      ])
    } finally { instance.unmount() }
  })

  test('Client capture releases on terminal blur without synthesizing an up event', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const host = clientHost({ mount: (_pane,_node,commit) => commit({type:'Text',children:['blur canvas']}) })
    const scrolls: number[] = []
    const instance = await render(<><EnableInput /><ModsPane
      pane={paneWithClients(clientNode({width:16,height:2}),host.clients)}
      onInteract={async()=>{}} onClose={async()=>{}} onFocus={async()=>({})}
      onScroll={async(_pane,by)=>{scrolls.push(by)}} /></>, {
      stdout:stdout as never,stdin:stdin as never,patchConsole:false,exitOnCtrlC:false,
    })
    try {
      await settle()
      const rect=nodeCache.get(renderedElement(stdout,'blur canvas','ink-text'))!
      stdin.push(`\u001b[<0;${rect.x+1};${rect.y+1}M`)
      stdin.push('\u001b[O')
      stdin.push(`\u001b[<65;${rect.x+1};${rect.y+1}M`)
      await settle()
      expect(host.calls.pointers).toEqual([{type:'down',x:0,y:0,button:'left'}])
      expect(scrolls).toEqual([1])
    } finally {instance.unmount()}
  })

  test('reports real Client hover boundaries and only present pointer modifiers', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const host = clientHost({ mount: (_pane, _node, commit) => {
      commit({ type: 'Text', children: ['hover canvas'] })
    } })
    const current = paneWithClients(clientNode({ width: 16, height: 3 }), host.clients)
    const instance = await render(<><EnableInput /><ModsPane pane={current}
      onInteract={async () => {}} onClose={async () => {}} onFocus={async () => ({})}
      onScroll={async () => ({})} /></>, {
      stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      const rect = nodeCache.get(renderedElement(stdout, 'hover canvas', 'ink-text'))!
      stdin.push(`\u001b[<35;${rect.x + 1};${rect.y + 1}M`)
      stdin.push(`\u001b[<63;${rect.x + 3};${rect.y + 2}M`)
      stdin.push(`\u001b[<35;${rect.x + 25};${rect.y + 2}M`)
      await settle()
      expect(host.calls.pointers).toEqual([
        { type: 'enter', x: 0, y: 0 },
        { type: 'move', x: 0, y: 0 },
        { type: 'move', x: 2, y: 1, shift: true, alt: true, ctrl: true },
        { type: 'leave', x: 2, y: 1 },
      ])
    } finally { instance.unmount() }
  })

  test('Client hover stays inside its region when the pointer crosses a local control', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const host = clientHost({ mount: (_pane, _node, commit) => {
      commit({ type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Text', children: ['region canvas'] },
        { type: 'Button', props: { key: 'local', label: 'Local' }, press: { plugin: 'fixture', handle: 41 } },
      ] })
    } })
    const instance = await render(<><EnableInput /><ModsPane
      pane={paneWithClients(clientNode({ width: 16, height: 3 }), host.clients)}
      onInteract={async () => {}} onClose={async () => {}} onFocus={async () => ({})}
      onScroll={async () => ({})} /></>, {
      stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      const canvas = nodeCache.get(renderedElement(stdout, 'region canvas', 'ink-text'))!
      const button = nodeCache.get(renderedElement(stdout, '[ Local ]', 'ink-text'))!
      stdin.push(`\u001b[<35;${canvas.x + 1};${canvas.y + 1}M`)
      stdin.push(`\u001b[<35;${button.x + 1};${button.y + 1}M`)
      stdin.push(`\u001b[<35;${canvas.x + 25};${canvas.y + 1}M`)
      await settle()
      expect(host.calls.pointers).toEqual([
        { type: 'enter', x: 0, y: 0 },
        { type: 'move', x: 0, y: 0 },
        { type: 'move', x: button.x - canvas.x, y: button.y - canvas.y },
        { type: 'leave', x: button.x - canvas.x, y: button.y - canvas.y },
      ])
    } finally { instance.unmount() }
  })

  test('real stdin pointer and key reach the production Client Worker and ui.message reply reaches Ink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mods-client-input-'))
    const envKeys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR']
    const savedEnv = envKeys.map(key => process.env[key])
    for (const key of envKeys) process.env[key] = root
    const diagnostics: unknown[] = []
    const runtime = createModsRuntime({ onDiagnostic: event => diagnostics.push(event), services: {
      uiPresentation: () => ({ columns: 160, rows: 40, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }),
    } })
    let instance: Awaited<ReturnType<typeof render>> | undefined
    try {
      const entry = join(root, 'register.ts')
      await writeFile(entry, `export function register(on) {
        on('session.start',async($,e,next)=>{await $.ui.open({id:'input',focus:true});return next(e)});
        on('ui.render',($,e)=>{const {Box,Button,Client}=$.ui.resolve(e);return Box({children:[
          Client({key:'surface',module:'./surface.ts',width:24,height:3}),
          Button({key:'after',label:'After',onPress:()=>{}})
        ]})});
        on('ui.message',($,e)=>({props:'reply:'+e.data}));
      }`)
      await writeFile(join(root, 'surface.ts'), `export default function Surface(props,s) {
        if(s.state===undefined){
          s.setState(0);
          s.onPointer(e=>{if(e.type==='down'){s.setState(s.state+1);s.post(e.type+':'+e.x+':'+e.y)}});
          s.onKey(e=>s.post('key:'+e.key));
        }
        return s.elements.Box({flexDirection:'column',children:[
          s.elements.Text({children:(props??'waiting')+':state='+s.state}),
          s.elements.Input({key:'local',placeholder:'local input',onSubmit:value=>s.post('submit:'+value)})
        ]});
      }`)
      await runtime.bind({ cwd: root, surface: 'terminal', isInteractive: true, sessionId: 'client-input' })
      await runtime.reconcile([{name:'client-input',storageId:'client-input@test',pluginRoot:root,entrypoints:[entry]}])
      const stdout = new Output()
      const stdin = new Input()
      const current = runtime.ui.getSnapshot()[0]!
      expect(diagnostics).toEqual([])
      expect(current.tree).toMatchObject({ children: [{ type: 'Client', props: { module: 'surface.ts' } }, { type: 'Button' }] })
      const errors: unknown[] = []
      function Consumer() {
        const live = React.useSyncExternalStore(runtime.ui.subscribe, runtime.ui.getSnapshot)[0]!
        return <><EnableInput /><ModsPane pane={live} canFocus
          onInteract={async () => {}} onClose={async () => {}}
          onFocus={async (pane, element) => runtime.ui.focus(pane.owner, {
            requestId:pane.id, ...(element===undefined?{}:{element}), origin:{kind:'person'},
          }, {columns:160,rows:40,isFullscreen:true,composerEmpty:true,hasDialog:false,keyboardOwned:false})}
          onScroll={async () => ({})} onError={error => errors.push(error)} /></>
      }
      instance = await render(<Consumer />, {
        stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
      })
      const waitFor = async (text: string) => {
        const deadline = Date.now() + 2_000
        while (!stripAnsi(stdout.output).includes(text) && Date.now() < deadline) await settle()
        expect(errors).toEqual([])
        expect(stripAnsi(stdout.output)).toContain(text)
      }
      await waitFor('waiting:state=0')
      const rect = nodeCache.get(renderedElement(stdout, 'waiting:state=0', 'ink-text'))!
      stdin.push(`\u001b[<0;${rect.x + 2};${rect.y + 1}M`)
      stdin.push(`\u001b[<0;${rect.x + 2};${rect.y + 1}m`)
      await waitFor('reply:down:1:0:state=1')
      stdin.push('k')
      await waitFor('reply:key:k:state=1')
      stdin.push('\u001b')
      await settle()
      await settle()
      const beforeEscapeKey = stdout.output.length
      stdin.push('q')
      await settle()
      expect(stripAnsi(stdout.output.slice(beforeEscapeKey))).not.toContain('reply:key:q')
      const input = renderedElement(stdout, 'local input', 'ink-text').parentNode!
      const inputRect = nodeCache.get(input)!
      const ink = instances.get(stdout as never) as unknown as InkInstance
      ink.setAltScreenActive(true, true)
      stdin.push(`\u001b[<0;${inputRect.x + 1};${inputRect.y + 1}M`)
      stdin.push(`\u001b[<0;${inputRect.x + 1};${inputRect.y + 1}m`)
      await settle()
      expect(runtime.ui.getSnapshot()[0]).toMatchObject({focused:true,focusedElement:'surface'})
      expect(getFocusManager(input).activeElement === input).toBe(true)
      stdin.push('abc\r')
      await waitFor('reply:submit:abc:state=1')
      stdin.push('\t')
      await settle()
      const after = renderedElement(stdout, '[ After ]', 'ink-text').parentNode!
      expect(getFocusManager(after).activeElement === after).toBe(true)
      expect(runtime.ui.getSnapshot()[0]).toMatchObject({ focused: true, focusedElement: 'after' })
      stdin.push('\u001b[Z')
      await settle()
      expect(getFocusManager(input).activeElement === input).toBe(true)
      expect(runtime.ui.getSnapshot()[0]).toMatchObject({ focused: true, focusedElement: 'surface' })
      expect(errors).toEqual([])
    } finally {
      instance?.unmount()
      instance?.cleanup()
      await runtime.dispose()
      envKeys.forEach((key, i) => { if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i] })
      await rm(root, {recursive:true,force:true})
    }
  })

  test('removes a stopped Client frame and input handlers after a host failure', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const errors: unknown[] = []
    const host = clientHost({ mount: (_pane, _node, commit) => {
      commit({ type: 'Text', children: ['failing canvas'] })
    } })
    let report: ((error: unknown) => void) | undefined
    const clients: ModClients = {
      reconcile: host.clients.reconcile,
      mount(pane, node, commit, onError) {
        report = onError
        return host.clients.mount(pane, node, commit, onError)
      },
    }
    const current = paneWithClients(clientNode({width:20,height:2}), clients)
    const instance = await render(<><EnableInput /><ModsPane pane={current}
      onInteract={async () => {}} onClose={async () => {}} onFocus={async () => ({})}
      onScroll={async () => ({})} onError={error => errors.push(error)} /></>, {
      stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      const rect = nodeCache.get(renderedElement(stdout, 'failing canvas', 'ink-text'))!
      stdin.push(`\u001b[<0;${rect.x + 1};${rect.y + 1}M`)
      await settle()
      report!(new Error('Client render failed'))
      await settle()
      expect(elements(stdout, true).some(item => item.text === 'failing canvas')).toBe(false)
      const count = host.calls.pointers.length
      stdin.push(`\u001b[<32;${rect.x + 2};${rect.y + 1}M`)
      stdin.push('k')
      await settle()
      expect(host.calls.pointers).toHaveLength(count)
      expect(host.calls.keys).toEqual([])
      expect(errors.map(String)).toEqual(['Error: Client render failed'])
    } finally { instance.unmount() }
  })

  test('reports a synchronous Client mount rejection without breaking the pane', async () => {
    const stdout = new Output()
    const errors: unknown[] = []
    const clients: ModClients = {
      reconcile() {},
      mount() { throw new Error('Client drawing is stale') },
    }
    const instance = await render(<ModsPane pane={paneWithClients(clientNode(), clients)}
      onInteract={async () => {}} onClose={async () => {}} onFocus={async () => ({})}
      onScroll={async () => ({})} onError={error => errors.push(error)} />, {
      stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      expect(errors.map(String)).toEqual(['Error: Client drawing is stale'])
      expect(stripAnsi(stdout.output)).not.toContain('Client')
    } finally { instance.unmount() }
  })

  test('reports a Client without a host instead of drawing an empty placeholder', async () => {
    const stdout = new Output()
    const errors: unknown[] = []
    const instance = await render(<ModsPane pane={pane(clientNode())}
      onInteract={async () => {}} onClose={async () => {}} onFocus={async () => ({})}
      onScroll={async () => ({})} onError={error => errors.push(error)} />, {
      stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      expect(errors).toHaveLength(1)
      expect(String(errors[0])).toMatch(/Client.*host|clients/i)
      expect(stripAnsi(stdout.output)).not.toContain('Client')
    } finally { instance.unmount() }
  })
})

describe('ModsPane terminal hover', () => {
  test('accepts official Box hover offsets and validates integer values', () => {
    for (const edge of ['top', 'left', 'right', 'bottom']) {
      expect(validateModRenderTree({ type: 'Box', props: { key: 'row' }, children: [
        { type: 'Box', props: { position: 'absolute' }, hover: { [edge]: -1 }, children: ['CARD'] },
      ] })).toBeDefined()
      expect(() => validateModRenderTree({ type: 'Box', props: { [edge]: 1.5 } })).toThrow(/integer/)
      expect(() => validateModRenderTree({ type: 'Box', props: {}, hover: { [edge]: 1.5 } })).toThrow(/integer/)
    }
  })

  test('accepts language and startLine on official Code diff elements', () => {
    expect(validateModRenderTree({
      type: 'Code',
      props: {
        source: '@@ -1 +1 @@\n-old\n+new',
        format: 'diff',
        language: 'typescript',
        startLine: 12,
      },
    })).toBeDefined()
  })

  test('Box offsets anchor, stretch and clip real absolute children to the pane', async () => {
    const stdout = new Output()
    const tree = { type: 'Box', props: { width: 12, height: 4 }, children: [
      { type: 'Box', props: { position: 'absolute', top: -1, left: -2 }, children: ['hidden\n012345'] },
      { type: 'Box', props: { position: 'absolute', right: 1, bottom: 0, width: 3, height: 1 }, children: ['END'] },
      { type: 'Box', props: { position: 'absolute', top: 1, bottom: 1, left: 2, right: 2 }, children: ['span'] },
    ] }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      expect(stripAnsi(stdout.output)).not.toContain('hidden')
      expect(stripAnsi(stdout.output)).toContain('23span')
      expect(nodeCache.get(renderedElement(stdout, 'END', 'ink-text'))).toMatchObject({ x: 8, y: 3 })
      const span = renderedElement(stdout, 'span', 'ink-text').parentNode!
      expect(nodeCache.get(span)).toMatchObject({ x: 2, y: 1, width: 8, height: 2 })
    } finally { instance.unmount() }
  })

  test('Box position paints absolute children over earlier content without moving flow siblings', async () => {
    const stdout = new Output()
    const tree = { type: 'Box', props: { flexDirection: 'column', width: 16, height: 4, position: 'relative' }, children: [
      { type: 'Text', children: ['abcdefghijklmnop'] },
      { type: 'Text', children: ['following row'] },
      { type: 'Box', props: { position: 'absolute', top: 0, left: 3, width: 4, height: 1 }, children: ['CARD'] },
    ] }
    expect(() => validateModRenderTree(tree)).not.toThrow()
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      expect(stripAnsi(stdout.output)).toContain('abcCARDhijklmnop\nfollowing row')
      expect(nodeCache.get(renderedElement(stdout, 'CARD', 'ink-text'))).toMatchObject({ x: 3, y: 0 })
      expect(nodeCache.get(renderedElement(stdout, 'following row', 'ink-text'))).toMatchObject({ y: 1 })
    } finally { instance.unmount() }
  })

  test('Box scoped display reveal paints real children and releases heat outside the group', async () => {
    const stdout = new Output()
    const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [
      { type: 'Text', children: ['trigger'], hover: { scope: 'card', bold: true }, group: { plugin: 'fixture' } },
      { type: 'Box', props: { display: 'none' }, hover: { scope: 'card', display: 'flex' }, group: { plugin: 'fixture' }, children: ['revealed content'] },
      { type: 'Box', props: { display: 'none' }, hover: { scope: 'card', display: 'flex' }, group: { plugin: 'other' }, children: ['other plugin content'] },
    ] }
    expect(() => validateModRenderTree(tree)).not.toThrow()
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      expect(stripAnsi(stdout.output)).not.toContain('revealed content')
      stdout.output = ''
      moveMouseTo(stdout, renderedElement(stdout, 'trigger', 'ink-text'))
      await settle()
      expect(stripAnsi(stdout.output)).toContain('revealed content')
      expect(stripAnsi(stdout.output)).not.toContain('other plugin content')
      moveMouseTo(stdout, renderedElement(stdout, 'revealed content', 'ink-text'))
      await settle()
      expect(renderedElement(stdout, 'trigger', 'ink-text').textStyles?.bold).toBe(true)
      const ink = instances.get(stdout as never) as unknown as InkInstance
      ink.dispatchHover(-1, -1)
      await settle()
      expect(domElement(stdout, 'revealed content', 'ink-box').style.display).toBe('none')
      expect(renderedElement(stdout, 'trigger', 'ink-text').textStyles?.bold).not.toBe(true)
    } finally { instance.unmount() }
  })

  test('wraps Box string children as terminal text', async () => {
    const stdout = new Output()
    const instance = await modsPane({
      type: 'Box',
      props: { key: 'row' },
      children: ['direct label'],
    }, stdout)
    try {
      await settle()
      expect(renderedElement(stdout, 'direct label', 'ink-text')).toBeDefined()
    } finally {
      instance.unmount()
    }
  })

  test('nearest unique keyed Box heats itself and shadows the parent scope for its descendants', async () => {
    const stdout = new Output()
    const tree = {
      type: 'Box', props: { key: 'outer', flexDirection: 'column' }, hover: { borderColor: 'ansi:red' }, children: [
        { type: 'Text', children: ['outer label'], hover: { bold: true } },
        { type: 'Box', props: { key: 'inner' }, hover: { backgroundColor: 'ansi:blue' }, children: [
          { type: 'Text', children: ['inner label'], hover: { underline: true } },
        ] },
      ],
    }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      const outerLabel = renderedElement(stdout, 'outer label', 'ink-text')
      const innerLabel = renderedElement(stdout, 'inner label', 'ink-text')
      const outer = outerLabel.parentNode!
      const inner = innerLabel.parentNode!

      moveMouseTo(stdout, outerLabel)
      await settle()
      expect(outer.style.borderColor).toBe('ansi:red')
      expect(outerLabel.textStyles?.bold).toBe(true)
      expect(inner.style.backgroundColor).toBeUndefined()
      expect(innerLabel.textStyles?.underline).toBeUndefined()

      moveMouseTo(stdout, innerLabel)
      await settle()
      expect(outer.style.borderColor).toBe('ansi:red')
      expect(outerLabel.textStyles?.bold).toBe(true)
      expect(inner.style.backgroundColor).toBe('ansi:blue')
      expect(innerLabel.textStyles?.underline).toBe(true)
    } finally {
      instance.unmount()
    }
  })

  test('links the same plugin and scope across render sites while isolating plugins', async () => {
    const stdout = new Output()
    const instance = await render(
      <>
        <ModsPane
          pane={pane({ type: 'Text', children: ['owner source'], hover: { scope: 'shared', bold: true }, group: { plugin: 'owner' } }, { id: 'source' })}
          onInteract={async () => {}}
          onClose={async () => {}}
          onFocus={async () => ({})}
          onScroll={async () => ({})}
        />
        <ModsPane
          pane={pane({
            type: 'Box', props: { flexDirection: 'column' }, children: [
              { type: 'Box', hover: { scope: 'shared', backgroundColor: 'ansi:blue' }, group: { plugin: 'owner' }, children: [
                { type: 'Text', children: ['owner peer'] },
              ] },
              { type: 'Text', children: ['other peer'], hover: { scope: 'shared', italic: true }, group: { plugin: 'other' } },
            ],
          }, { id: 'peers', placement: 'dock' })}
          onInteract={async () => {}}
          onClose={async () => {}}
          onFocus={async () => ({})}
          onScroll={async () => ({})}
        />
      </>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new Input() as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await settle()
      moveMouseTo(stdout, renderedElement(stdout, 'owner source', 'ink-text'))
      await settle()
      const styles = latestStyles(stdout, ['owner source', 'other peer'])
      expect(styles.get('owner source')?.bold).toBe(true)
      expect(renderedElement(stdout, 'owner peer', 'ink-box').style.backgroundColor).toBe('ansi:blue')
      expect(styles.get('other peer')?.italic).toBeUndefined()
    } finally {
      instance.unmount()
    }
  })

  test('nested Text follows scoped heat but cannot heat the group itself', async () => {
    const stdout = new Output()
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Text', children: ['source'], hover: { scope: 'shared', bold: true }, group: { plugin: 'owner' } },
        { type: 'Text', children: [
          { type: 'Text', children: ['nested'], hover: { scope: 'shared', underline: true }, group: { plugin: 'owner' } },
        ] },
      ],
    }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      const source = renderedElement(stdout, 'source', 'ink-text')
      const nestedContainer = renderedElement(stdout, 'nested', 'ink-text')
      const nested = domElement(stdout, 'nested', 'ink-virtual-text')

      moveMouseTo(stdout, nestedContainer)
      await settle()
      expect(source.textStyles?.bold).toBeUndefined()
      expect(nested.textStyles?.underline).toBeUndefined()

      moveMouseTo(stdout, source)
      await settle()
      expect(source.textStyles?.bold).toBe(true)
      expect(nested.textStyles?.underline).toBe(true)
    } finally {
      instance.unmount()
    }
  })

  test('renders realm Links with children, then label, then URL fallback', async () => {
    const ui = createModUiRealm('fixture', isProxy)
    const { Box, Link, Text } = ui.resolve({ surface: 'terminal', component: 'Pane' })
    const href = 'https://example.com/'
    const tree = ui.materialize(Box!({ flexDirection: 'column', children: [
      Link!({ href, label: 'Direct label' }),
      ui.h(Link, { href, label: 'JSX label' }, [null, false, [], '']),
      ui.h(Link, { href }, [null, undefined, false, []]),
      ui.h(Link, { href, label: 'Ignored label' }, ui.h(Text, { bold: true }, 'Inline child')),
      ui.h(Link, { href, label: 'Ignored zero label' }, 0),
      { type: 'Link', props: { href, label: 'Empty array label' }, children: [] },
      { type: 'Link', props: { href, label: 'Empty string label' }, children: [''] },
    ] }), () => { throw new Error('unexpected callback') })
    const stdout = new Output()
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      for (const text of ['Direct label', 'JSX label', href, 'Inline child', '0', 'Empty array label', 'Empty string label']) {
        expect(renderedElement(stdout, text, 'ink-text')).toBeDefined()
      }
      expect(elements(stdout, false).some(({ text }) => text.includes('Ignored'))).toBe(false)
    } finally { instance.unmount() }
  })

  test('keeps nested inline Text inert inside Link content', async () => {
    const stdout = new Output()
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Text', children: ['source'], hover: { scope: 'shared', bold: true }, group: { plugin: 'owner' } },
        { type: 'Link', props: { href: 'https://example.com/' }, children: [
          { type: 'Text', children: ['nested link'], hover: { scope: 'shared', underline: true }, group: { plugin: 'owner' } },
        ] },
      ],
    }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      const source = renderedElement(stdout, 'source', 'ink-text')
      const nestedContainer = renderedElement(stdout, 'nested link', 'ink-text')
      const nested = domElement(stdout, 'nested link', 'ink-virtual-text')

      moveMouseTo(stdout, nestedContainer)
      await settle()
      expect(source.textStyles?.bold).toBeUndefined()
      expect(nested.textStyles?.underline).toBeUndefined()

      moveMouseTo(stdout, source)
      await settle()
      expect(source.textStyles?.bold).toBe(true)
      expect(nested.textStyles?.underline).toBe(true)
    } finally {
      instance.unmount()
    }
  })

  test('releases named hover heat when a hovered member unmounts', async () => {
    const stdout = new Output()
    const sourceTree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Text', children: ['source'], hover: { scope: 'shared', bold: true }, group: { plugin: 'owner' } },
        { type: 'Text', children: ['peer'], hover: { scope: 'shared', underline: true }, group: { plugin: 'owner' } },
      ],
    }
    const renderPane = (tree: unknown) => (
      <ModsPane
        pane={pane(tree)}
        onInteract={async () => {}}
        onClose={async () => {}}
        onFocus={async () => ({})}
        onScroll={async () => ({})}
      />
    )
    const instance = await render(renderPane(sourceTree), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new Input() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    try {
      await settle()
      moveMouseTo(stdout, renderedElement(stdout, 'source', 'ink-text'))
      await settle()
      expect(renderedElement(stdout, 'peer', 'ink-text').textStyles?.underline).toBe(true)

      instance.rerender(renderPane({
        type: 'Text',
        children: ['peer'],
        hover: { scope: 'shared', underline: true },
        group: { plugin: 'owner' },
      }))
      await settle()
      expect(renderedElement(stdout, 'peer', 'ink-text').textStyles?.underline).toBeUndefined()
    } finally {
      instance.unmount()
    }
  })

  test('releases named hover heat when its rendered host changes', async () => {
    const stdout = new Output()
    const renderPane = (source: unknown) => (
      <ModsPane
        pane={pane({
          type: 'Box', props: { flexDirection: 'column' }, children: [
            source,
            { type: 'Text', children: ['peer'], hover: { scope: 'shared', underline: true }, group: { plugin: 'owner' } },
          ],
        })}
        onInteract={async () => {}}
        onClose={async () => {}}
        onFocus={async () => ({})}
        onScroll={async () => ({})}
      />
    )
    const instance = await render(renderPane({
      type: 'Text',
      children: ['source'],
      hover: { scope: 'shared', bold: true },
      group: { plugin: 'owner' },
    }), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new Input() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    try {
      await settle()
      moveMouseTo(stdout, renderedElement(stdout, 'source', 'ink-text'))
      await settle()
      expect(renderedElement(stdout, 'peer', 'ink-text').textStyles?.underline).toBe(true)

      instance.rerender(renderPane({
        type: 'Button',
        props: { key: 'source', label: 'Source' },
        hover: { scope: 'shared', bold: true },
        press: { plugin: 'owner', handle: 1 },
      }))
      await settle()
      expect(renderedElement(stdout, 'peer', 'ink-text').textStyles?.underline).toBeUndefined()
    } finally {
      instance.unmount()
    }
  })

  test('tracks nested named hover groups independently', async () => {
    const stdout = new Output()
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Box', hover: { scope: 'outer', backgroundColor: 'ansi:red' }, group: { plugin: 'owner' }, children: [
          { type: 'Text', children: ['outer target'] },
          { type: 'Box', hover: { scope: 'inner', borderColor: 'ansi:blue' }, group: { plugin: 'owner' }, children: [
            { type: 'Text', children: ['inner target'] },
          ] },
        ] },
        { type: 'Text', children: ['outer peer'], hover: { scope: 'outer', bold: true }, group: { plugin: 'owner' } },
      ],
    }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      const outerTarget = renderedElement(stdout, 'outer target', 'ink-text')
      const innerTarget = renderedElement(stdout, 'inner target', 'ink-text')
      const outer = outerTarget.parentNode!
      const inner = innerTarget.parentNode!
      const peer = renderedElement(stdout, 'outer peer', 'ink-text')

      moveMouseTo(stdout, innerTarget)
      await settle()
      expect(outer.style.backgroundColor).toBe('ansi:red')
      expect(peer.textStyles?.bold).toBe(true)
      expect(inner.style.borderColor).toBe('ansi:blue')

      moveMouseTo(stdout, outerTarget)
      await settle()
      expect(outer.style.backgroundColor).toBe('ansi:red')
      expect(peer.textStyles?.bold).toBe(true)
      expect(inner.style.borderColor).toBeUndefined()
    } finally {
      instance.unmount()
    }
  })

  test('keeps duplicate and invalid keyed Box descendants inert', async () => {
    const stdout = new Output()
    const tree = {
      type: 'Box', props: { key: 'outer', flexDirection: 'column' }, children: [
        { type: 'Text', children: ['outer target'], hover: { bold: true } },
        { type: 'Box', props: { key: 'duplicate' }, children: [
          { type: 'Text', children: ['first'], hover: { underline: true } },
        ] },
        { type: 'Box', props: { key: 'duplicate' }, children: [
          { type: 'Text', children: ['second'], hover: { italic: true } },
        ] },
        { type: 'Box', props: { key: 17 }, children: [
          { type: 'Text', children: ['invalid'], hover: { strikethrough: true } },
        ] },
      ],
    }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      const outerTarget = renderedElement(stdout, 'outer target', 'ink-text')
      const first = renderedElement(stdout, 'first', 'ink-text')
      const second = renderedElement(stdout, 'second', 'ink-text')
      const invalid = renderedElement(stdout, 'invalid', 'ink-text')

      moveMouseTo(stdout, outerTarget)
      await settle()
      expect(outerTarget.textStyles?.bold).toBe(true)
      expect(first.textStyles?.underline).toBeUndefined()
      expect(second.textStyles?.italic).toBeUndefined()
      expect(invalid.textStyles?.strikethrough).toBeUndefined()

      moveMouseTo(stdout, first)
      await settle()
      expect(outerTarget.textStyles?.bold).toBe(true)
      expect(first.textStyles?.underline).toBe(true)

      moveMouseTo(stdout, second)
      await settle()
      expect(outerTarget.textStyles?.bold).toBe(true)
      expect(second.textStyles?.italic).toBeUndefined()

      moveMouseTo(stdout, invalid)
      await settle()
      expect(outerTarget.textStyles?.bold).toBe(true)
      expect(invalid.textStyles?.strikethrough).toBeUndefined()
    } finally {
      instance.unmount()
    }
  })

  test('reveals unscoped display:flex only while its keyed Box is hot', async () => {
    const stdout = new Output()
    const tree = {
      type: 'Box', props: { key: 'row' }, children: [
        { type: 'Text', children: ['target'] },
        { type: 'Box', props: { display: 'none' }, hover: { display: 'flex' }, children: [
          { type: 'Text', children: ['details'] },
        ] },
      ],
    }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      const target = renderedElement(stdout, 'target', 'ink-text')
      const row = target.parentNode!
      const details = domElement(stdout, 'details', 'ink-box')
      expect(details.style.display).toBe('none')

      moveMouseTo(stdout, target)
      await settle()
      expect(row.style.display).not.toBe('none')
      expect(details.style.display).toBe('flex')

      const ink = instances.get(stdout as unknown as NodeJS.WriteStream) as unknown as InkInstance
      ink.dispatchHover(-1, -1)
      await settle()
      expect(details.style.display).toBe('none')
    } finally {
      instance.unmount()
    }
  })

  test('normalizes terminal ANSI color names in base and hover styles', async () => {
    const stdout = new Output()
    const instance = await modsPane({
      type: 'Box',
      props: { key: 'colors', backgroundColor: 'red' },
      hover: { borderColor: 'blueBright' },
      children: [{
        type: 'Text',
        props: { color: 'green', backgroundColor: 'black' },
        children: ['colors'],
        hover: { color: 'yellowBright', backgroundColor: 'magenta' },
      }],
    }, stdout)
    try {
      await settle()
      const label = renderedElement(stdout, 'colors', 'ink-text')
      const box = label.parentNode!
      expect(box.style.backgroundColor).toBe('#e5484d')
      expect(label.textStyles).toMatchObject({ color: '#46a758', backgroundColor: '#000000' })

      moveMouseTo(stdout, label)
      await settle()
      expect(box.style.borderColor).toBe('#5b8def')
      expect(label.textStyles).toMatchObject({ color: '#ffe629', backgroundColor: '#d6409f' })
    } finally {
      instance.unmount()
    }
  })

  test('renders a plain Button hotkey as suggestion-colored inline text', async () => {
    const stdout = new Output()
    const instance = await modsPane({
      type: 'Button',
      props: { key: 'run', label: 'Run', hotkey: 'r', plain: true },
      press: { plugin: 'owner', handle: 1 },
    }, stdout)
    try {
      await settle()
      const label = renderedElement(stdout, 'r: Run', 'ink-text')
      const hotkey = domElement(stdout, 'r', 'ink-virtual-text')
      expect(label).toBeDefined()
      expect(hotkey.textStyles?.color).toBeDefined()
    } finally {
      instance.unmount()
    }
  })

  test('merges Button hover text styles after preserving focused and hovered chrome', async () => {
    const stdout = new Output()
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Button', props: { key: 'other', label: 'Other' }, press: { plugin: 'owner', handle: 1 } },
        { type: 'Button', props: { key: 'run', label: 'Run', dimColor: true }, hover: { scope: 'run', bold: false, underline: true, inverse: false, dimColor: true }, press: { plugin: 'owner', handle: 2 } },
      ],
    }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      const otherLabel = renderedElement(stdout, '[ Other ]', 'ink-text')
      const runLabel = renderedElement(stdout, '[ Run ]', 'ink-text')
      moveMouseTo(stdout, otherLabel)
      await settle()
      const inactiveColor = runLabel.textStyles?.color
      expect(runLabel.textStyles).toMatchObject({ bold: true })
      expect(runLabel.textStyles?.underline).toBeUndefined()
      expect(runLabel.textStyles?.inverse).toBeUndefined()

      moveMouseTo(stdout, runLabel)
      await settle()
      expect(runLabel.textStyles?.bold).toBeUndefined()
      expect(runLabel.textStyles?.underline).toBe(true)
      expect(runLabel.textStyles?.inverse).toBeUndefined()
      expect(runLabel.textStyles?.color).toBe(inactiveColor)

      moveMouseTo(stdout, otherLabel)
      await settle()
      expect(runLabel.textStyles).toMatchObject({ bold: true })
      expect(runLabel.textStyles?.underline).toBeUndefined()
      expect(runLabel.textStyles?.inverse).toBeUndefined()
      expect(runLabel.textStyles?.color).toBe(inactiveColor)
    } finally {
      instance.unmount()
    }
  })
})

// Exercise the production interceptor without mounting its settings watcher/AppState.
const interceptorSource = readFileSync(new URL('../keybindings/KeybindingProviderSetup.tsx', import.meta.url), 'utf8')
const ChordInterceptor = new Function('useCallback', 'useInput', 'resolveKeyWithChordState',
  new Bun.Transpiler({ loader: 'tsx' }).transformSync(interceptorSource.slice(interceptorSource.indexOf('function ChordInterceptor('))) + '\nreturn ChordInterceptor',
)(React.useCallback, useInput, resolveKeyWithChordState) as React.ComponentType<Record<string, unknown>>

function Bindings({ children, bindings = {} }: { children: React.ReactNode; bindings?: Record<string, string | null> }) {
  const pending = React.useRef<ParsedKeystroke[] | null>(null)
  const registry = React.useRef(new Map())
  const contexts = React.useRef(new Set<KeybindingContextName>(['Global']))
  return <KeybindingProvider
    bindings={parseBindings([{ context: 'Global', bindings }])}
    pendingChordRef={pending} pendingChord={null}
    setPendingChord={value => { pending.current = value }}
    activeContexts={contexts.current}
    registerActiveContext={value => { contexts.current.add(value) }}
    unregisterActiveContext={value => { contexts.current.delete(value) }}
    handlerRegistryRef={registry}
  ><ChordInterceptor bindings={parseBindings([{ context: 'Global', bindings }])}
    pendingChordRef={pending} setPendingChord={(value: ParsedKeystroke[] | null) => { pending.current = value }}
    activeContexts={contexts.current} handlerRegistryRef={registry} />{children}</KeybindingProvider>
}

const fileButton = (key: string, action?: string) => ({
  type: 'Button', props: { key, label: key, ...(action ? { action } : {}) },
  press: { plugin: 'fixture', handle: 1 },
})

describe('ModsPane placement tabs', () => {
  function PaneGroup({ initial = 'first', calls }: { initial?: string; calls: string[] }) {
    const [shown, setShown] = React.useState(initial)
    const owner = React.useMemo(() => ({ first: {}, second: {} }), [])
    const draw = (id: 'first' | 'second', title: string) => Object.assign(
      pane({ type: 'Text', children: [`${title} body`] }, {
        id,
        title,
        owner: owner[id],
        focused: shown === id,
      }),
      { shown: shown === id },
    ) as ModUiPane
    const focus = async (current: ModUiPane) => {
      calls.push(current.id)
      setShown(current.id)
      return { focused: true }
    }
    return <>
      <ModsPane pane={draw('first', 'First')} onFocus={focus}
        onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}} />
      <ModsPane pane={draw('second', 'Second')} onFocus={focus}
        onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}} />
    </>
  }

  test('renders one placement body, omits single-pane titles, and switches tabs by real click', async () => {
    const singleOutput = new Output()
    const single = await modsPane({ type: 'Text', children: ['only body'] }, singleOutput)
    try {
      await settle()
      expect(stripAnsi(singleOutput.output)).toContain('only body')
      expect(stripAnsi(singleOutput.output)).not.toContain('Test')
    } finally { single.unmount() }

    const stdout = new Output()
    const calls: string[] = []
    const instance = await render(<PaneGroup calls={calls} />, {
      stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      expect(elements(stdout, true).some(item => item.text === 'First body')).toBe(true)
      expect(elements(stdout, true).some(item => item.text === 'Second body')).toBe(false)
      expect(renderedElement(stdout, ' First ', 'ink-text')).toBeDefined()
      const second = renderedElement(stdout, ' Second ', 'ink-text')
      const rect = nodeCache.get(second)!
      const ink = instances.get(stdout as never) as unknown as InkInstance
      dispatchClick(ink.rootNode, rect.x, rect.y)
      await settle()
      expect(calls).toEqual(['second'])
      expect(elements(stdout, true).some(item => item.text === 'Second body')).toBe(true)
      expect(elements(stdout, true).some(item => item.text === 'First body')).toBe(false)
    } finally { instance.unmount() }
  })

  test('switches placement tabs through real arrow input and the host focus API', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const calls: string[] = []
    const instance = await render(<><EnableInput /><PaneGroup calls={calls} /></>, {
      stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false,
    })
    try {
      await settle()
      stdin.push('\u001b[C')
      await settle()
      expect(calls).toEqual(['second'])
      expect(stripAnsi(stdout.output)).toContain('Second body')
      stdin.push('\u001b[D')
      await settle()
      expect(calls).toEqual(['second', 'first'])
      expect(stripAnsi(stdout.output)).toContain('First body')
    } finally { instance.unmount() }
  })
})

describe('ModsPane input repair', () => {
  test('Button hotkeys press the last visible match only while the pane owns keyboard focus', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const calls: string[] = []
    const button = (key: string, hotkey: string) => ({ ...fileButton(key), props: { key, label: key, hotkey } })
    const draw = (focused = true, focusedElement = 'first') => <><EnableInput /><ModsPane canFocus
      pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: [
        button('first', 'w'), button('last', 'w'), button('digit', '1'),
        { type: 'Box', props: { display: 'none' }, children: [button('hidden', 'w')] },
        { type: 'Input', props: { key: 'input', placeholder: 'Type' }, press: { plugin: 'fixture', handle: 2 } },
      ] }, { owner, focused, focusedElement })}
      onInteract={async (_pane, _drawing, _callback, kind, key, value) => { calls.push(`${kind}:${key}:${value ?? ''}`) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      for (const key of ['w', 'W', '1', '\u001bw', '\u0017', '\u001b[200~w\u001b[201~']) {
        stdin.push(key)
        await settle()
      }
      expect(calls).toEqual(['press:last:', 'press:last:', 'press:digit:'])
      instance.rerender(<ThemeProvider>{draw(true, 'input')}</ThemeProvider>)
      await settle()
      stdin.push('w\r')
      await settle()
      expect(calls.slice(3)).toEqual(['input.change:input:w', 'input.submit:input:w'])
      instance.rerender(<ThemeProvider>{draw(false)}</ThemeProvider>)
      await settle()
      stdin.push('w')
      await settle()
      expect(calls).toHaveLength(5)
    } finally { instance.unmount() }
  })

  test('unregisters old logical keys when attached DOM rows are reused', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const requests: string[] = []
    const reports: { keyRows?: readonly { plugin: string; key: string }[] }[] = []
    const draw = (keys: string[]) => <><EnableInput /><ModsPane
      pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: keys.map(key => fileButton(key)) }, { owner })}
      onFocus={async (_pane, key) => { requests.push(key!); return { focused: true, element: key } }}
      onReportMetrics={(_pane, metrics) => { reports.push(metrics) }}
      onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
    /></>
    const instance = await render(draw(['a', 'b', 'c']), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      const first = renderedElement(stdout, '[ a ]', 'ink-text').parentNode!
      getFocusManager(first).focus(first)
      await settle()
      instance.rerender(<ThemeProvider>{draw(['b', 'c', 'd'])}</ThemeProvider>)
      await settle()
      expect(renderedElement(stdout, '[ b ]', 'ink-text').parentNode).toBe(first)
      expect(reports.at(-1)?.keyRows?.map(row => row.key)).toEqual(['b', 'c', 'd'])
      requests.length = 0
      stdin.push('\u001b[B')
      await settle()
      expect(requests).toEqual(['c'])
      expect(getFocusManager(first).activeElement).toBe(renderedElement(stdout, '[ c ]', 'ink-text').parentNode!)
    } finally { instance.unmount() }
  })

  test('long path keys retain exact focus and activation identity', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const keys = [`file:${'nested/'.repeat(24)}source.ts`, `file:${'目录/'.repeat(28)}文件.ts`]
    const requests: string[] = []
    const pressed: string[] = []
    const instance = await render(<><EnableInput /><ModsPane
      pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: keys.map((key, index) => ({
        ...fileButton(key), props: { key, label: `file ${index + 1}` },
      })) }, { focusedElement: keys[0] })}
      onFocus={async (_pane, key) => { requests.push(key!); return { focused: true, element: key } }}
      onInteract={async (_pane, _drawing, _callback, _kind, key) => { pressed.push(key) }}
      onClose={async () => {}} onScroll={async () => {}}
    /></>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      for (const index of [0, 1]) {
        if (index) { stdin.push('\u001b[B'); await settle() }
        const target = renderedElement(stdout, `[ file ${index + 1} ]`, 'ink-text').parentNode!
        expect(getFocusManager(target).activeElement).toBe(target)
        stdin.push('\r')
        await settle()
        expect(pressed).toEqual(keys.slice(0, index + 1))
      }
      expect(requests).toEqual([keys[1]])
    } finally { instance.unmount() }
  })

  test('removes only the changed duplicate registration and its previous plugin rows', async () => {
    const stdout = new Output()
    const reports: { keyRows?: readonly { plugin: string; key: string; top: number; bottom: number }[] }[] = []
    const owner = {}
    const draw = (plugin: string, includeFirst: boolean) => <ModsPane
      pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: [
        ...(includeFirst ? [{ type: 'Box', props: { key: 'row', height: 2 }, group: { plugin }, children: ['first'] }] : []),
        { type: 'Box', props: { key: 'row', height: 3 }, group: { plugin: 'original' }, children: ['second'] },
      ] }, { owner, focused: false })}
      onReportMetrics={(_pane, metrics) => { reports.push(metrics) }}
      onFocus={async () => ({})} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
    />
    const instance = await render(draw('original', true), { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      expect(reports.at(-1)?.keyRows).toEqual([{ plugin: 'original', key: 'row', top: 0, bottom: 2 }])
      instance.rerender(<ThemeProvider>{draw('replacement', true)}</ThemeProvider>)
      await settle()
      expect(reports.at(-1)?.keyRows).toEqual([
        { plugin: 'original', key: 'row', top: 2, bottom: 5 },
        { plugin: 'replacement', key: 'row', top: 0, bottom: 2 },
      ])
      instance.rerender(<ThemeProvider>{draw('replacement', false)}</ThemeProvider>)
      await settle()
      expect(reports.at(-1)?.keyRows).toEqual([{ plugin: 'original', key: 'row', top: 0, bottom: 3 }])
    } finally { instance.unmount() }
  })

  test('diff rendering follows the body width through dock and inline resize', async () => {
    const stdout = new Output()
    const owner = {}
    const source = `--- a/文件.txt\n+++ b/文件.txt\n@@ -1 +1 @@\n-${'旧'.repeat(90)}\n+${'新'.repeat(90)}\n`
    const store = createStore(getDefaultAppState())
    const draw = (columns: number) => {
      const placement = columns >= 110 ? 'dock' : 'inline'
      const bodyColumns = placement === 'dock' ? Math.floor(columns / 2) - 2 : columns - 4
      return <AppStoreContext.Provider value={store}><Box width={placement === 'dock' ? Math.floor(columns / 2) : columns}>
        <ModsPane pane={pane({ type: 'Code', props: { source, format: 'diff' } }, { owner, placement, bodyColumns, bodyRows: 20 })}
          onFocus={async () => ({})} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
        />
      </Box></AppStoreContext.Provider>
    }
    stdout.columns = 160
    const instance = await render(draw(160), { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      for (const columns of [160, 110, 109, 80, 160]) {
        stdout.columns = columns
        stdout.emit('resize')
        instance.rerender(<ThemeProvider>{draw(columns)}</ThemeProvider>)
        await settle()
        assert.ok(instances.get(stdout as never), stripAnsi(stdout.output))
        const widths = elements(stdout, false).filter(({ node }) => node.nodeName === 'ink-raw-ansi').map(({ node }) => node.yogaNode!.getComputedWidth())
        expect(widths.length).toBeGreaterThan(0)
        const bodyColumns = columns >= 110 ? Math.floor(columns / 2) - 2 : columns - 4
        expect(Math.max(...widths)).toBeLessThanOrEqual(bodyColumns)
        expect(widths.reduce((sum, width) => sum + width, 0)).toBe(bodyColumns)
      }
    } finally { instance.unmount() }
  })

  test('diff respects a nested padded Code container instead of using the whole pane', async () => {
    const stdout = new Output()
    const store = createStore(getDefaultAppState())
    const source = `--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-${'a'.repeat(90)}\n+${'b'.repeat(90)}\n`
    const reports: number[] = []
    const draw = (width: number) => <AppStoreContext.Provider value={store}><ModsPane
      pane={pane({ type: 'Box', props: { width, paddingX: 2 }, children: [{ type: 'Code', props: { source, format: 'diff' } }] })}
      onReportMetrics={(_pane, metrics) => { reports.push(metrics.contentRows) }}
      onFocus={async () => ({})} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
    /></AppStoreContext.Provider>
    const instance = await render(draw(30), { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      for (const width of [30, 50, 20]) {
        instance.rerender(<ThemeProvider>{draw(width)}</ThemeProvider>)
        await settle()
        const leaves = elements(stdout, false).filter(({ node }) => node.nodeName === 'ink-raw-ansi')
        expect(leaves.length).toBeGreaterThan(0)
        expect(leaves.reduce((sum, { node }) => sum + node.yogaNode!.getComputedWidth(), 0)).toBe(width - 4)
        const viewport = elements(stdout, false).find(({ node }) => node.style.overflowY === 'scroll')!.node
        const content = viewport.childNodes[0] as DOMElement
        expect(reports.at(-1)).toBe(Math.ceil(content.yogaNode!.getComputedHeight()))
      }
    } finally { instance.unmount() }
  })

  test('multiple diff blocks settle metrics through the live host subscription', async () => {
    const stdout = new Output()
    stdout.columns = 160
    const store = createStore(getDefaultAppState())
    const owner = {}
    const source = `@@ -1,3 +1,3 @@\n first\n-${'old'.repeat(24)}\n+${'new'.repeat(24)}\n last\n`
    const ui = createModUi({
      pluginOf: () => 'fixture',
      dispatch: async (_owner, _event, input, core) => core(input),
      draw: async () => ({ type: 'Box', props: { flexDirection: 'column', paddingTop: 1, paddingRight: 1 }, children: [
        fileButton('file:first'),
        ...Array.from({ length: 5 }, () => ({ type: 'Code', props: { source, format: 'diff' } })),
      ] }),
      invokeDrawing: async () => undefined,
      releaseDrawing: async () => {},
    })
    await ui.open(owner, { id: 'diff', title: 'Diff' }, { kind: 'plugin' }, {
      columns: 160, rows: 50, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false,
    })
    await ui.commit(owner)
    const reports: unknown[] = []
    function Host() {
      const current = React.useSyncExternalStore(ui.subscribe, ui.getSnapshot)[0]!
      return <AppStoreContext.Provider value={store}><Box width={80}>
        <ModsPane pane={current}
          onReportMetrics={(pane, metrics) => { reports.push(metrics); return ui.reportMetrics(pane.id, metrics) }}
          onFocus={async () => ({})} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
        />
      </Box></AppStoreContext.Provider>
    }
    const instance = await render(<Host />, { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      assert.ok(instances.get(stdout as never), JSON.stringify(reports.slice(0, 12)))
      const count = reports.length
      await settle()
      expect(reports.length).toBe(count)
      const viewport = elements(stdout, false).find(({ node }) => node.style.overflowY === 'scroll')!.node
      const content = viewport.childNodes[0] as DOMElement
      expect(ui.getSnapshot()[0]!.contentRows).toBe(Math.ceil(content.yogaNode!.getComputedHeight()))
      expect(elements(stdout, false).filter(({ node }) => node.nodeName === 'ink-raw-ansi').length).toBeGreaterThan(0)
    } finally { instance.unmount() }
  })

  test.each(['Diff', ''])('dock drawing uses the actual body height as the composer grows and shrinks (title=%s)', async title => {
    const stdout = new Output()
    stdout.columns = 160
    stdout.rows = 50
    const owner = {}
    const presentation = { columns: 160, rows: 50, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false }
    const budgets: number[] = []
    const reports: number[] = []
    const ui = createModUi({
      pluginOf: () => 'fixture',
      dispatch: async (_owner, _event, input, core) => core(input),
      draw: async (_owner, input) => {
        budgets.push((input.props as { scroll: { bodyRows: number } }).scroll.bodyRows)
        return { type: 'Box', props: { flexDirection: 'column' }, children: Array.from({ length: 60 }, (_, i) => ({ type: 'Text', children: [`body ${i}`] })) }
      },
      invokeDrawing: async () => {}, releaseDrawing: async () => {},
    })
    await ui.open(owner, { id: 'diff', title }, { kind: 'person' }, presentation)
    await ui.commit(owner)
    function Host({ bottom }: { bottom: number }) {
      const current = React.useSyncExternalStore(ui.subscribe, ui.getSnapshot)[0]!
      return <Box width={160} height={50} flexDirection="column">
        <Box flexGrow={1} flexDirection="row" overflow="hidden">
          <Box flexDirection="column" flexShrink={0} width="50%" overflow="hidden">
            <ModsPane pane={current}
              onReportMetrics={(pane, metrics) => { reports.push(metrics.bodyRows); return ui.reportMetrics(pane.id, metrics) }}
              onFocus={async () => ({})} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
            />
          </Box>
        </Box>
        <Box height={bottom} flexShrink={0}><Text>Composer</Text></Box>
      </Box>
    }
    const instance = await render(<Host bottom={5} />, { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      for (const bottom of [5, 12, 3, 5, 25, 3]) {
        const bodyRows = 50 - bottom
        instance.rerender(<ThemeProvider><Host bottom={bottom} /></ThemeProvider>)
        await settle()
        const viewport = elements(stdout, false).find(({ node }) => node.style.overflowY === 'scroll')!.node
        expect(viewport.yogaNode!.getComputedHeight()).toBe(bodyRows)
        expect(ui.getSnapshot()[0]!.bodyRows).toBe(bodyRows)
        expect(budgets.at(-1)).toBe(bodyRows)
        const count = reports.length
        await settle()
        expect(reports.length).toBe(count)
        await ui.focus(owner, { requestId: 'diff', origin: { kind: 'person' } }, presentation)
        expect(ui.getSnapshot()[0]!.bodyRows).toBe(bodyRows)
      }
    } finally { instance.unmount(); await ui.release(owner) }
  })

  test('Input paints a dim placeholder and shows submitLabel only under actual focus', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const calls: (string | undefined)[] = []
    const instance = await render(<><EnableInput /><ModsPane pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: [
      fileButton('first'),
      { type: 'Input', props: { key: 'input', label: 'Reply', placeholder: 'Question', submitLabel: 'send' }, press: { plugin: 'fixture', handle: 2 } },
    ] }, { focusedElement: 'first' })}
      onInteract={async (_pane, _drawing, _callback, _kind, _key, value) => { calls.push(value) }}
      onFocus={async (_pane, element) => ({ focused: true, element })} onClose={async () => {}} onScroll={async () => ({})}
    /></>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      expect(stripAnsi(stdout.output)).toContain('Reply: Question')
      expect(stripAnsi(stdout.output)).not.toContain('send')
      const placeholderColor = renderedElement(stdout, 'Question', 'ink-text').textStyles?.color
      expect(placeholderColor).toBeDefined()
      stdin.push('\t')
      await settle()
      expect(stripAnsi(stdout.output)).toContain('Reply: Question send')
      expect(renderedElement(stdout, 'Question', 'ink-text').textStyles).toMatchObject({ color: placeholderColor, inverse: true })
      stdin.push('answer\r')
      await settle()
      expect(calls).toEqual(['answer', 'answer'])
      expect(renderedElement(stdout, 'answer', 'ink-text').textStyles?.color).not.toBe(placeholderColor)
      stdout.output = ''
      stdin.push('\u001b[Z')
      await settle()
      expect(stripAnsi(stdout.output)).toContain('Reply: answer')
      expect(stripAnsi(stdout.output)).not.toContain('send')
    } finally { instance.unmount() }
  })

  test('Select and Input chrome follows actual Tab, BackTab and mouse focus', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [
      fileButton('first'),
      { type: 'Select', props: { key: 'base', options: [{ value: 'HEAD' }, { value: 'main' }] }, press: { plugin: 'fixture', handle: 2 } },
      { type: 'Input', props: { key: 'ask', placeholder: 'Question' }, press: { plugin: 'fixture', handle: 3 } },
    ] }
    const instance = await render(<><EnableInput /><ModsPane pane={pane(tree, { focusedElement: 'first' })}
      onFocus={async (_pane, element) => ({ focused: true, element })}
      onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
    /></>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      expect(latestStyles(stdout, ['HEAD ↑↓', 'Question']).get('Question')?.inverse).not.toBe(true)
      stdin.push('\t')
      await settle()
      expect(latestStyles(stdout, ['HEAD ↑↓']).get('HEAD ↑↓')?.inverse).toBe(true)
      stdin.push('\t')
      await settle()
      expect(latestStyles(stdout, ['HEAD ↑↓']).get('HEAD ↑↓')?.inverse).not.toBe(true)
      expect(latestStyles(stdout, ['Question']).get('Question')?.inverse).toBe(true)
      stdin.push('\u001b[Z')
      await settle()
      expect(latestStyles(stdout, ['HEAD ↑↓']).get('HEAD ↑↓')?.inverse).toBe(true)
      expect(latestStyles(stdout, ['Question']).get('Question')?.inverse).not.toBe(true)
      const input = renderedElement(stdout, 'Question', 'ink-text')
      const rect = nodeCache.get(input)!
      const ink = instances.get(stdout as never) as unknown as InkInstance
      dispatchClick(ink.rootNode, rect.x, rect.y)
      await settle()
      expect(getFocusManager(input).activeElement).toBe(input.parentNode!)
      expect(latestStyles(stdout, ['HEAD ↑↓']).get('HEAD ↑↓')?.inverse).not.toBe(true)
      expect(latestStyles(stdout, ['Question']).get('Question')?.inverse).toBe(true)
    } finally { instance.unmount() }
  })

  test('host snapshot focus does not feed back as person input or blur another owner', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const requests: string[] = []
    const draw = (key: string, focused = true) => <><EnableInput />
      <Box tabIndex={0}><Text>composer</Text></Box>
      <ModsPane pane={pane({ type: 'Box', children: [fileButton('a'), fileButton('b')] }, { owner, focused, focusedElement: key })}
        onFocus={async (_pane, element) => { requests.push(element!); return { focused: true, element } }}
        onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
      /></>
    const instance = await render(draw('a'), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      requests.length = 0
      instance.rerender(<ThemeProvider>{draw('b')}</ThemeProvider>)
      await settle()
      const target = renderedElement(stdout, '[ b ]', 'ink-text').parentNode!
      expect(getFocusManager(target).activeElement).toBe(target)
      expect(requests).toEqual([])
      const composer = renderedElement(stdout, 'composer', 'ink-text').parentNode!
      getFocusManager(composer).focus(composer)
      instance.rerender(<ThemeProvider>{draw('b', false)}</ThemeProvider>)
      await settle()
      expect(getFocusManager(composer).activeElement).toBe(composer)
    } finally { instance.unmount() }
  })

  test('bare arrows follow host landing, skip hidden controls and do not wrap', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const focused: string[] = []
    const scrolls: number[] = []
    const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [
      fileButton('a'),
      { type: 'Box', props: { display: 'none' }, children: [fileButton('hidden')] },
      fileButton('b'), fileButton('c'),
    ] }
    const instance = await render(<><EnableInput /><ModsPane
      pane={pane(tree, { focusedElement: 'a' })}
      onFocus={async (_pane, element) => {
        focused.push(element!)
        return { element: element === 'b' ? 'c' : element }
      }}
      onScroll={async (_pane, by) => { scrolls.push(by) }}
      onInteract={async () => {}} onClose={async () => {}}
    /></>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      focused.length = 0
      stdin.push('\u001b[B')
      await settle()
      expect(focused).toEqual(['b'])
      const target = renderedElement(stdout, '[ c ]', 'ink-text').parentNode!
      expect(getFocusManager(target).activeElement).toBe(target)
      stdin.push('\u001b[B')
      await settle()
      expect(focused).toEqual(['b'])
      expect(scrolls).toEqual([])
    } finally { instance.unmount() }
  })

  test('restores host focus on deny and stay without a changed snapshot, serializing rapid arrows', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const requests: string[] = []
    let phase: 'deny' | 'stay' | 'allow' = 'deny'
    let activeRequests = 0
    let maxActive = 0
    let current = 'a'
    const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [fileButton('a'), fileButton('b'), fileButton('c')] }
    const instance = await render(<><EnableInput /><ModsPane pane={pane(tree, { focusedElement: 'a' })}
      onFocus={async (_pane, key) => {
        requests.push(key!)
        maxActive = Math.max(maxActive, ++activeRequests)
        await new Promise(resolve => setTimeout(resolve, 10))
        activeRequests--
        if (phase === 'deny') return { deny: 'blocked', focused: true, element: current }
        if (phase === 'allow') current = key!
        return { focused: true, element: current }
      }} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
    /></>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      requests.length = 0
      const first = renderedElement(stdout, '[ a ]', 'ink-text').parentNode!
      stdin.push('\u001b[B')
      await settle()
      expect(getFocusManager(first).activeElement).toBe(first)
      phase = 'stay'
      stdin.push('\u001b[B')
      await settle()
      expect(getFocusManager(first).activeElement).toBe(first)
      phase = 'allow'
      stdin.push('\u001b[B\u001b[B')
      await settle()
      expect(requests).toEqual(['b', 'b', 'b', 'c'])
      expect(maxActive).toBe(1)
      expect(getFocusManager(first).activeElement).toBe(renderedElement(stdout, '[ c ]', 'ink-text').parentNode!)
    } finally { instance.unmount() }
  })

  test('Escape cancels queued focus moves and late landings cannot reacquire the composer', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    let requests = 0
    let finish: ((value: unknown) => void) | undefined
    let focused = true
    const draw = () => <><EnableInput /><ModsPane pane={pane({ type: 'Box', children: [fileButton('a'), fileButton('b'), fileButton('c')] }, { owner, focused, focusedElement: 'a' })}
      onFocus={async (_pane, key) => {
        if (key === undefined) {
          focused = false
          instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
          return { focused: false }
        }
        if (key === 'a') return { focused: true, element: 'a' }
        requests++
        return new Promise(resolve => { finish = resolve })
      }} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
    /></>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('\u001b[B\u001b[B')
      await settle()
      expect(requests).toBe(1)
      stdin.push('\u001b')
      await settle()
      finish!({ focused: true, element: 'b' })
      await settle()
      expect(requests).toBe(1)
      const ink = instances.get(stdout as never) as unknown as InkInstance
      expect(getFocusManager(ink.rootNode).activeElement).toBeNull()
    } finally { instance.unmount() }
  })

  test('walks eight files across async five-row redraws using the rewritten landing', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    let selected = 0
    let start = 0
    let requests = 0
    const draw = () => <><EnableInput /><ModsPane key="paging"
      pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children:
        Array.from({ length: 5 }, (_, index) => fileButton(`slot-${index}`)),
      }, { owner, focusedElement: `slot-${selected - start}`, drawing: 7 + requests })}
      onFocus={async (_pane, key) => {
        requests++
        selected = start + Number(key!.slice(5))
        start = Math.min(3, Math.max(0, selected - 2))
        instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
        await new Promise(resolve => setTimeout(resolve, 15))
        return { focused: true, element: `slot-${selected - start}` }
      }} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
    /></>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      requests = 0
      stdin.push('\u001b[B'.repeat(7))
      let deadline = Date.now() + 2000
      while (requests < 7 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      expect({ selected, requests, start }).toEqual({ selected: 7, requests: 7, start: 3 })
      stdin.push('\u001b[A'.repeat(7))
      deadline = Date.now() + 2000
      while (requests < 14 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      expect(selected).toBe(0)
      expect(requests).toBe(14)
    } finally { instance.unmount() }
  })

  test.each([
    { rewriteLanding: false, rapid: false, replyDelay: 5 }, { rewriteLanding: false, rapid: true, replyDelay: 5 },
    { rewriteLanding: true, rapid: false, replyDelay: 5 }, { rewriteLanding: true, rapid: true, replyDelay: 5 },
    { rewriteLanding: true, rapid: true, replyDelay: 0 },
  ])('walks real file keys through delayed redraws (old-window=$rewriteLanding, continuous=$rapid, delay=$replyDelay)', async ({ rewriteLanding, rapid, replyDelay = 5 }) => {
      const stdout = new Output()
      const stdin = new Input()
      const owner = {}
      const files = Array.from({ length: 16 }, (_, index) => `file:file-${String(index + 1).padStart(2, '0')}.txt`)
      const requests: string[] = []
      const timers = new Set<ReturnType<typeof setTimeout>>()
      let selected = 0
      let start = 0
      let drawing = 7
      let focusedElement = files[0]
      const draw = () => <><EnableInput /><ModsPane
        pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: files.slice(start, start + 5).map(key => ({
          type: 'Box', children: [{ ...fileButton(key), props: { key, label: key, ...(rewriteLanding && key === files[selected] ? { autoFocus: true } : {}) } }],
        })) }, { owner, focusedElement, drawing, revision: drawing })}
        onFocus={async (_pane, key) => {
          requests.push(key!)
          const before = start
          selected = files.indexOf(key!)
          start = Math.min(11, Math.max(0, selected - 2))
          focusedElement = rewriteLanding ? files[before + selected - start] : key!
          if (replyDelay) await new Promise(resolve => setTimeout(resolve, replyDelay))
          const revision = drawing + 1
          const timer = setTimeout(() => {
            timers.delete(timer)
            drawing = revision
            instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
          }, 0)
          timers.add(timer)
          return { focused: true, element: focusedElement, revision }
        }}
        onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
      /></>
      const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
      try {
        await settle()
        requests.length = 0
        for (const direction of ['down', 'up'] as const) {
          const key = direction === 'down' ? '\u001b[B' : '\u001b[A'
          const expected = direction === 'down' ? files.slice(1) : files.slice(0, -1).reverse()
          if (rapid) {
            stdin.push(key.repeat(15))
            const deadline = Date.now() + 2000
            while (Date.now() < deadline) {
              const target = elements(stdout, true).find(({ node, text }) =>
                node.nodeName === 'ink-text' && text === `[ ${expected.at(-1)} ]`,
              )?.node.parentNode
              if (requests.length === expected.length && target && getFocusManager(target).activeElement === target) break
              await new Promise(resolve => setTimeout(resolve, 5))
            }
          } else {
            for (const file of expected) {
              stdin.push(key)
              const deadline = Date.now() + 2000
              let target: DOMElement | undefined
              do {
                await new Promise(resolve => setTimeout(resolve, 5))
                target = elements(stdout, true).find(({ node, text }) =>
                  node.nodeName === 'ink-text' && text === `[ ${file} ]`,
                )?.node.parentNode
              } while ((!target || getFocusManager(target).activeElement !== target) && Date.now() < deadline)
              expect(target).toBeDefined()
              expect(getFocusManager(target!).activeElement === target).toBe(true)
            }
          }
          expect(requests.splice(0)).toEqual(expected)
          expect(selected).toBe(direction === 'down' ? 15 : 0)
          const target = renderedElement(stdout, `[ ${files[selected]} ]`, 'ink-text').parentNode!
          expect(getFocusManager(target).activeElement).toBe(target)
          stdin.push(key)
          await settle()
          expect(requests).toEqual([])
        }
      } finally {
        for (const timer of timers) clearTimeout(timer)
        instance.unmount()
      }
  })

  for (const redrawFirst of [false, true]) {
    test(`keeps an old-window landing on the reused selected row when redraw is ${redrawFirst ? 'before' : 'after'} reply`, async () => {
      const stdout = new Output()
      const stdin = new Input()
      const owner = {}
      const files = Array.from({ length: 16 }, (_, i) => `file:${i + 1}`)
      let selected = 2
      let focusedElement = files[selected]
      let drawing = 1
      const requests: string[] = []
      let redraw: () => void = () => {}
      let reply: () => void = () => {}
      const windowStart = () => Math.min(11, Math.max(0, selected - 2))
      const draw = () => <><EnableInput /><ModsPane
        pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: files.slice(windowStart(), windowStart() + 5).map(key => ({
          type: 'Box', children: [{ ...fileButton(key), props: { key, label: key, ...(key === files[selected] ? { autoFocus: true } : {}) } }],
        })) }, { owner, focusedElement, drawing, revision: drawing })}
        onFocus={async (_pane, key) => {
          requests.push(key!)
          const before = windowStart()
          selected = files.indexOf(key!)
          focusedElement = files[before + selected - windowStart()]
          redraw = () => { drawing++; instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>) }
          await new Promise<void>(resolve => { reply = resolve })
          return { focused: true, element: focusedElement }
        }}
        onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
      /></>
      const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
      try {
        await settle()
        requests.length = 0
        const slot = renderedElement(stdout, '[ file:3 ]', 'ink-text').parentNode!
        for (const next of [3, 4]) {
          stdin.push('\u001b[B')
          await settle()
          if (redrawFirst) { redraw(); await settle(); reply() }
          else { reply(); await settle(); redraw() }
          await settle()
          const target = renderedElement(stdout, `[ ${files[next]} ]`, 'ink-text').parentNode!
          expect(target).toBe(slot)
          expect(getFocusManager(target).activeElement).toBe(target)
          expect(selected).toBe(next)
          expect(requests).toEqual(files.slice(3, next + 1))
        }
        for (const key of ['file:6', 'file:4']) {
          focusedElement = key
          instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
          await settle()
          const target = renderedElement(stdout, `[ ${key} ]`, 'ink-text').parentNode!
          expect(getFocusManager(target).activeElement).toBe(target)
          expect(requests).toEqual(['file:4', 'file:5'])
        }
      } finally { reply(); instance.unmount() }
    })
  }

  test('walks burst file navigation through the live host and subscription commit', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const files = Array.from({ length: 16 }, (_, i) => `file:${i + 1}`)
    const requests: string[] = []
    let traversal = Promise.withResolvers<void>()
    let selected = 0
    const start = () => Math.min(11, Math.max(0, selected - 2))
    const ui = createModUi({
      pluginOf: () => 'fixture',
      dispatch: async (_owner, event, input, core) => {
        if (event !== 'ui.focus' || input.element === undefined) return core(input)
        requests.push(input.element as string)
        const before = start()
        selected = files.indexOf(input.element as string)
        const landing = files[before + selected - start()]
        void ui.invalidate(owner, 'ui.render')
        return core({ ...input, element: landing })
      },
      draw: async () => ({
        type: 'Box', props: { flexDirection: 'column' }, children: files.slice(start(), start() + 5).map(key => ({
          type: 'Box', children: [{ ...fileButton(key), props: { key, label: key, ...(key === files[selected] ? { autoFocus: true } : {}) } }],
        })),
      }),
      invokeDrawing: async () => {}, releaseDrawing: async () => {},
    })
    await ui.open(owner, { id: 'test', focus: true }, { kind: 'person' }, {
      columns: 80, rows: 30, isFullscreen: false, composerEmpty: true, hasDialog: false, keyboardOwned: false,
    })
    await ui.commit(owner)
    function Host() {
      const current = React.useSyncExternalStore(ui.subscribe, ui.getSnapshot)[0]!
      React.useEffect(() => {
        if (requests.length === 15) traversal.resolve()
      }, [current])
      return <><EnableInput /><ModsPane pane={current}
        onFocus={async (pane, element) => {
          const result = await ui.focus(pane.owner, { requestId: pane.id, element, origin: { kind: 'person' } })
          return { ...(result as object), revision: ui.getSnapshot()[0]!.revision }
        }} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
      /></>
    }
    const instance = await render(<Host />, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      requests.length = 0
      for (const down of [true, false]) {
        traversal = Promise.withResolvers<void>()
        stdin.push((down ? '\u001b[B' : '\u001b[A').repeat(15))
        await traversal.promise
        await settle()
        expect(requests.splice(0)).toEqual(down ? files.slice(1) : files.slice(0, -1).reverse())
        expect(selected).toBe(down ? 15 : 0)
        const target = renderedElement(stdout, `[ ${files[selected]} ]`, 'ink-text').parentNode!
        expect(getFocusManager(target).activeElement).toBe(target)
      }
    } finally { instance.unmount(); await ui.release(owner) }
  })

  test('Escape releases a pending host draw so Tab can enter through a newer drawing', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const stalled = Promise.withResolvers<void>()
    const requests: (string | undefined)[] = []
    const invalidations: Promise<void>[] = []
    let pauseNext = false
    const ui = createModUi({
      pluginOf: () => 'fixture',
      dispatch: async (_owner, event, input, core) => {
        if (event === 'ui.focus') {
          requests.push(input.element as string | undefined)
          if (input.element !== undefined) invalidations.push(ui.invalidate(owner, 'ui.render'))
        }
        return core(input)
      },
      draw: async () => {
        if (pauseNext) { pauseNext = false; await stalled.promise }
        return { type: 'Box', children: [
          { ...fileButton('one'), props: { key: 'one', label: 'one', autoFocus: true } },
          fileButton('two'),
        ] }
      },
      invokeDrawing: async () => {}, releaseDrawing: async () => {},
    })
    await ui.open(owner, { id: 'test', focus: true }, { kind: 'person' }, {
      columns: 80, rows: 30, isFullscreen: false, composerEmpty: true, hasDialog: false, keyboardOwned: false,
    })
    await ui.commit(owner)
    function Host() {
      const current = React.useSyncExternalStore(ui.subscribe, ui.getSnapshot)[0]!
      return <><EnableInput /><ModsPane canFocus pane={current}
        onFocus={async (pane, element) => {
          const result = await ui.focus(pane.owner, { requestId: pane.id, element, origin: { kind: 'person' } })
          return { ...(result as object), revision: ui.getSnapshot()[0]!.revision }
        }} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
      /></>
    }
    const instance = await render(<Host />, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      requests.length = 0
      pauseNext = true
      stdin.push('\u001b[B')
      await settle()
      expect(requests).toEqual(['two'])
      stdin.push('\u001b')
      await settle()
      expect(ui.getSnapshot()[0]!.focused).toBe(false)
      stdin.push('\t')
      await settle()
      expect(requests).toEqual(['two', undefined, 'one'])
      const target = renderedElement(stdout, '[ one ]', 'ink-text').parentNode!
      expect(getFocusManager(target).activeElement).toBe(target)
    } finally {
      stalled.resolve()
      await Promise.all(invalidations)
      instance.unmount()
      await ui.release(owner)
    }
  })

  test.each(['commit', 'escape', 'owner', 'hidden', 'unmount'] as const)('holds queued arrows until the published revision commits or is cancelled by %s', async mode => {
    const stdout = new Output()
    const stdin = new Input()
    let owner = {}
    let focused = true
    let visible = true
    let revision = 1
    let selected = 2
    const focusedElement = 'file:3'
    let waiting = true
    const files = Array.from({ length: 8 }, (_, i) => `file:${i + 1}`)
    const calls: (string | undefined)[] = []
    const draw = () => <><EnableInput /><ModsPane
      pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: files.slice(Math.min(3, Math.max(0, selected - 2)), Math.min(3, Math.max(0, selected - 2)) + 5).map(key => ({
        type: 'Box', children: [{ ...fileButton(key), props: { key, label: key, ...(key === files[selected] ? { autoFocus: true } : {}) } }],
      })) }, { owner, focused, visible, focusedElement, revision, drawing: revision })}
      onFocus={async (_pane, key) => {
        calls.push(key)
        if (key === undefined) { focused = false; instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>); return { focused: false } }
        return waiting ? { focused: true, element: 'file:3', revision: 2 } : { focused: true, element: key, revision }
      }} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
    /></>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    let unmounted = false
    try {
      await settle()
      calls.length = 0
      stdin.push('\u001b[B\u001b[B')
      await settle()
      expect(calls).toEqual(['file:4'])
      if (mode === 'unmount') { instance.unmount(); unmounted = true }
      else if (mode === 'escape') { stdin.push('\u001b'); await settle() }
      else if (mode === 'owner') owner = {}
      else if (mode === 'hidden') visible = false
      waiting = false
      selected = 3
      revision = 3 // React may skip the receipt's intermediate revision.
      if (!unmounted) instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(calls).toEqual(mode === 'commit' ? ['file:4', 'file:5'] : mode === 'escape' ? ['file:4', undefined] : ['file:4'])
      if (mode === 'commit') {
        const target = renderedElement(stdout, '[ file:5 ]', 'ink-text').parentNode!
        expect(getFocusManager(target).activeElement).toBe(target)
      }
      if (mode === 'escape') {
        const ink = instances.get(stdout as never) as unknown as InkInstance
        expect(getFocusManager(ink.rootNode).activeElement).toBeNull()
      }
    } finally { if (!unmounted) instance.unmount() }
  })

  test('person Tab enters an unfocused dock once without visiting global or hidden focus nodes', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const calls: (string | undefined)[] = []
    let outerFocus = 0
    const instance = await render(<><EnableInput />
      <Box tabIndex={0} autoFocus><Text>composer</Text></Box>
      <Box tabIndex={0} onFocus={() => { outerFocus++ }}><Text>unrelated</Text></Box>
      <ModsPane canFocus pane={pane({ type: 'Box', children: [
        { type: 'Box', props: { display: 'none' }, children: [fileButton('hidden')] },
        { type: 'Input', props: { key: 'ask' }, press: { plugin: 'fixture', handle: 1 } },
      ] }, { focused: false, placement: 'dock' })}
        onFocus={async (_pane, key) => {
          calls.push(key)
          return { focused: true, element: key }
        }} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
      />
    </>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      expect(calls).toEqual([])
      stdin.push('\t')
      await settle()
      expect(calls).toEqual(['ask'])
      expect(outerFocus).toBe(0)
    } finally { instance.unmount() }
  })

  test('blocked person entry neither Tabs nor clicks into a dock while a draft/dialog owns input', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const requests: unknown[] = []
    const instance = await render(<><EnableInput /><Box tabIndex={0} autoFocus><Text>composer</Text></Box>
      <ModsPane canFocus={false} pane={pane(fileButton('blocked'), { focused: false, placement: 'dock' })}
        onFocus={async (_pane, key) => { requests.push(key); return { focused: false } }}
        onInteract={async () => { requests.push('pressed') }} onClose={async () => {}} onScroll={async () => {}}
      />
    </>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('\t')
      await settle()
      const button = renderedElement(stdout, '[ blocked ]', 'ink-text')
      const rect = nodeCache.get(button)!
      const ink = instances.get(stdout as never) as unknown as InkInstance
      dispatchClick(ink.rootNode, rect.x, rect.y)
      await settle()
      expect(requests).toEqual([])
      expect(getFocusManager(button).activeElement).not.toBe(button.parentNode!)
    } finally { instance.unmount() }
  })

  test('removed file focus returns to the pane body while detail controls remain tabbable', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const requests: string[] = []
    const scrolls: number[] = []
    let detail = false
    const source = { type: 'Select', props: { key: 'source', options: [{ value: 'current' }, { value: 'turn' }] }, press: { plugin: 'fixture', handle: 2 } }
    const draw = () => <><EnableInput /><ModsPane
      pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: [source,
        { type: 'Box', props: { flexDirection: 'column' }, children: detail
          ? [fileButton('ask'), ...Array.from({ length: 20 }, (_, index) => ({ type: 'Text', children: [`line ${index}`] }))]
          : [fileButton('file:one'), fileButton('file:two')] },
        { type: 'Text', children: [detail ? 'Esc to back' : 'Enter to view'] },
      ] }, { owner, focusedElement: 'file:one' })}
      onFocus={async (_pane, key) => { requests.push(key!); return { focused: true, element: key } }}
      onInteract={async (_pane, _drawing, _callback, _kind, key) => {
        if (key === 'file:one') { detail = true; instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>) }
      }} onScroll={async (_pane, by) => { scrolls.push(by) }} onClose={async () => {}}
    /></>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('\r')
      await settle()
      expect(detail).toBe(true)
      stdin.push('\u001b[B\u001b[A')
      await settle()
      expect(scrolls).toEqual([1, -1])
      expect(requests).toEqual([])
      stdin.push('\t')
      await settle()
      expect(requests).toEqual(['source'])
      stdin.push('\u001b[B')
      await settle()
      expect(scrolls).toEqual([1, -1])
      expect(renderedElement(stdout, 'turn ↑↓', 'ink-text')).toBeDefined()
      stdin.push('\t')
      await settle()
      expect(requests).toEqual(['source', 'ask'])
    } finally { instance.unmount() }
  })

  test('detail arrows scroll with only a Back button but Input arrows stay in the editor', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const scrolls: number[] = []
    const owner = {}
    const draw = (input: boolean) => <><EnableInput /><ModsPane
      pane={pane(input
        ? { type: 'Input', props: { key: 'ask', autoFocus: true }, press: { plugin: 'fixture', handle: 1 } }
        : { type: 'Box', props: { flexDirection: 'column' }, children: [fileButton('back'), { type: 'Text', children: ['detail'] }] },
      { owner, focusedElement: input ? 'ask' : 'back' })}
      onFocus={async (_pane, key) => ({ element: key })} onScroll={async (_pane, by) => { scrolls.push(by) }}
      onClose={async () => {}} onInteract={async () => {}}
    /></>
    const instance = await render(draw(false), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('\u001b[B\u001b[A')
      await settle()
      expect(scrolls).toEqual([1, -1])
      instance.rerender(<ThemeProvider>{draw(true)}</ThemeProvider>)
      await settle()
      stdin.push('\u001b[B\u001b[A')
      await settle()
      expect(scrolls).toEqual([1, -1])
    } finally { instance.unmount() }
  })

  test('PromptInput overlay Escape guard leaves pane Escape unarmed and restores normal Rewind handling', async () => {
    const source = readFileSync(new URL('./PromptInput/PromptInput.tsx', import.meta.url), 'utf8')
    const start = source.indexOf('  useInput((char, key) => {\n    // Skip legacy input handling')
    const end = source.indexOf('\n  const swarmBanner', start)
    expect(start).toBeGreaterThan(0)
    let handler: (char: string, key: { escape: boolean }) => void = () => { throw new Error('missing PromptInput handler') }
    let rewind = 0
    const scope = {
      useInput: (callback: typeof handler) => { handler = callback },
      isModalOverlayActive: true, showTeamsDialog: false, showQuickOpen: false,
      showGlobalSearch: false, showHistoryPicker: false, getPlatform: () => 'linux',
      footerItemSelected: null, cursorOffset: 1, helpOpen: false, viewSelectionMode: 'none',
      speculation: { status: 'idle' }, isSideQuestionVisible: false, queuedCommands: [],
      isQueuedCommandEditable: () => false, messages: [{}], input: '', isLoading: false,
      doublePressEscFromEmpty: () => { rewind++ },
    }
    new Function('scope', `with(scope) {${new Bun.Transpiler({ loader: 'tsx' }).transformSync(source.slice(start, end))}}`)(scope)
    handler('', { escape: true })
    handler('', { escape: true })
    expect(rewind).toBe(0)
    scope.isModalOverlayActive = false
    handler('', { escape: true })
    expect(rewind).toBe(1)
  })

  test('legacy ownership suppresses only consumed DOM events, leaving ordinary keys and Tab intact', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const keys: string[] = []
    let focused = 0
    function Owner() {
      useInput((input, _key, event) => { if (input === 'x') event.stopImmediatePropagation() })
      return <><Box tabIndex={0} autoFocus onKeyDown={event => { keys.push(event.key) }} />
        <Box tabIndex={0} onFocus={() => { focused++ }} /></>
    }
    const instance = await render(<Owner />, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('x')
      await settle()
      stdin.push('y')
      await settle()
      stdin.push('\t')
      await settle()
      expect(keys).toEqual(['y', 'tab'])
      expect(focused).toBe(1)
    } finally { instance.unmount() }
  })

  test('Button action does not take an unmodified prompt key while an unfocused pane is mounted', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const calls: string[] = []
    const instance = await render(<Bindings bindings={{ w: 'app:cycleDiffBase', 'ctrl+w': 'app:cycleDiffBase' }}>
      <Box tabIndex={0} autoFocus onKeyDown={event => { calls.push(`composer:${event.text}`) }}><Text>composer</Text></Box>
      <ModsPane canFocus pane={pane(fileButton('action', 'app:cycleDiffBase'), { focused: false })}
        onInteract={async () => { calls.push('action') }} onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})} />
    </Bindings>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('w\u0017')
      await settle()
      expect(calls).toEqual(['composer:w', 'action'])
    } finally { instance.unmount() }
  })

  test('Button action leaves a focused Input printable key and submit to the editor', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const calls: string[] = []
    const instance = await render(<Bindings bindings={{ w: 'app:cycleDiffBase', enter: 'app:cycleDiffBase', 'ctrl+x b': 'app:cycleDiffBase' }}><ModsPane
      pane={pane({ type: 'Box', children: [fileButton('action', 'app:cycleDiffBase'),
        { type: 'Input', props: { key: 'reply' }, press: { plugin: 'fixture', handle: 2 } },
      ] }, { focusedElement: 'reply' })}
      onInteract={async (_pane, _drawing, _callback, kind, key, value) => { calls.push(`${kind}:${key}:${value ?? ''}`) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></Bindings>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('w\r')
      await settle()
      expect(calls).toEqual(['input.change:reply:w', 'input.submit:reply:w'])
      stdin.push('\u0018b')
      await settle()
      expect(calls.at(-1)).toBe('press:action:')
    } finally { instance.unmount() }
  })

  test('Button action chooses the last visible drawing match for a rebound chord', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const calls: string[] = []
    const instance = await render(<Bindings bindings={{ 'ctrl+x b': 'app:cycleDiffBase' }}><ModsPane canFocus
      pane={pane({ type: 'Box', children: [
        fileButton('first', 'app:cycleDiffBase'), fileButton('last', 'app:cycleDiffBase'),
        { type: 'Box', props: { display: 'none' }, children: [fileButton('hidden', 'app:cycleDiffBase')] },
      ] }, { focused: false })}
      onInteract={async (_pane, _drawing, _callback, _kind, key) => { calls.push(key) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></Bindings>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('\u0018b')
      await settle()
      expect(calls).toEqual(['last'])
    } finally { instance.unmount() }
  })

  test('pane action respects rebinding and executes Enter/Space exactly once, not the focused button', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const calls: string[] = []
    const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [
      fileButton('focused'), fileButton('action', 'app:cycleDiffBase'),
      fileButton('duplicate', 'app:cycleDiffBase'),
    ] }
    const instance = await render(<Bindings bindings={{ enter: 'app:cycleDiffBase', space: 'app:cycleDiffBase' }}>
      <EnableInput /><ModsPane pane={pane(tree, { focusedElement: 'focused' })}
        onFocus={async () => ({})} onScroll={async () => ({})} onClose={async () => {}}
        onInteract={async (_pane, _drawing, _callback, _kind, element) => { calls.push(element) }}
      />
    </Bindings>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('\r')
      await settle()
      stdin.push(' ')
      await settle()
      expect(calls).toEqual(['duplicate', 'duplicate'])
    } finally { instance.unmount() }
  })

  test('modifier actions and complete/cancel chords honor unbind, hidden targets and drawing cleanup', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const calls: string[] = []
    let drawing = 7
    let visible = true
    let unbind = false
    const owner = {}
    const tree = { type: 'Box', props: { flexDirection: 'column' }, children: [
      { type: 'Box', props: { display: 'none' }, children: [fileButton('hidden', 'app:cycleDiffBase')] },
      fileButton('cycle', 'app:cycleDiffBase'), fileButton('duplicate', 'app:cycleDiffBase'),
      fileButton('up', 'app:diffFileListUp'), fileButton('down', 'app:diffFileListDown'),
    ] }
    function Builtin() {
      const context = useOptionalKeybindingContext()!
      useEffect(() => context.registerHandler({ action: 'app:cycleDiffBase', context: 'Global', handler: () => { calls.push('builtin') } }), [context])
      return null
    }
    const draw = () => <Bindings bindings={{
      'ctrl+x b': 'app:cycleDiffBase', 'ctrl+up': 'app:diffFileListUp',
      'opt+down': unbind ? null : 'app:diffFileListDown',
    }}><ModsPane canFocus pane={pane(tree, { owner, drawing, focused: false, visible })}
      onFocus={async () => ({})} onScroll={async () => { throw new Error('modifier scrolled') }} onClose={async () => {}}
      onInteract={async (_pane, lease, _callback, _kind, key) => { calls.push(`${lease}:${key}`) }}
    />{!visible && <Builtin />}</Bindings>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('\u001b[1;5A\u001b[1;3B')
      await settle()
      stdin.push('\u0018')
      await settle()
      stdin.push('b')
      await settle()
      expect(calls).toEqual(['7:up', '7:down', '7:duplicate'])
      stdin.push('\u0018')
      await settle()
      stdin.push('\u001b')
      await settle()
      expect(calls).toHaveLength(3)
      drawing = 8
      unbind = true
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      stdin.push('\u001b[1;3B')
      await settle()
      stdin.push('\u0018')
      await settle()
      stdin.push('b')
      await settle()
      expect(calls).toEqual(['7:up', '7:down', '7:duplicate', '8:duplicate'])
      visible = false
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      stdin.push('\u0018')
      await settle()
      stdin.push('b')
      await settle()
      stdin.push('\u001b[1;5A')
      await settle()
      expect(calls).toEqual(['7:up', '7:down', '7:duplicate', '8:duplicate', 'builtin'])
    } finally { instance.unmount() }
  })

  test('wheel body-relative coordinates distinguish virtual list/detail and exclude title, outside and covering layers', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const wheels: { by: number; pointer?: { column: number; row: number } }[] = []
    const outside: string[] = []
    let covered = false
    let visible = true
    const owner = {}
    function Transcript() {
      useInput((_input, key, event) => {
        if (key.wheelUp || key.wheelDown) {
          outside.push(key.wheelUp ? 'up' : 'down')
          event.stopImmediatePropagation()
        }
      })
      return <Text>outside</Text>
    }
    const draw = () => <Box flexDirection="column"><Transcript /><ModsPane
      pane={pane({ type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Text', children: ['list region'] }, { type: 'Text', children: ['detail region'] },
      ] }, { owner, focused: false, visible, bodyRows: 4, contentRows: 2 })}
      onFocus={async () => { throw new Error('wheel stole focus') }} onClose={async () => {}} onInteract={async () => {}}
      onScroll={async (_pane, by, pointer) => { wheels.push({ by, pointer }) }}
    />{covered && <Box position="absolute" top={1} left={0} width={80} height={5}><Text>cover</Text></Box>}</Box>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      const list = nodeCache.get(renderedElement(stdout, 'list region', 'ink-text'))!
      const detail = nodeCache.get(renderedElement(stdout, 'detail region', 'ink-text'))!
      const wheel = (row: number, up = false) => stdin.push(`\u001b[<${up ? 64 : 65};3;${row + 1}M`)
      wheel(list.y)
      await settle()
      wheel(detail.y, true)
      await settle()
      wheel(list.y - 1)
      await settle()
      expect(wheels).toEqual([{ by: 1, pointer: { column: 2, row: 0 } }, { by: -1, pointer: { column: 2, row: 1 } }])
      covered = true
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      wheel(detail.y)
      await settle()
      covered = false
      visible = false
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      wheel(list.y, true)
      await settle()
      expect(wheels).toHaveLength(2)
      expect(outside).toEqual(['down', 'down', 'up'])
    } finally { instance.unmount() }
  })

  test('wheel hits the visible body before earlier transcript listeners even without overflow', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const wheels: unknown[] = []
    const transcript: string[] = []
    function Transcript() {
      useInput((_input, key, event) => {
        if (!key.wheelUp && !key.wheelDown) return
        transcript.push(key.wheelUp ? 'up' : 'down')
        event.stopImmediatePropagation()
      })
      return <Text>outside</Text>
    }
    const instance = await render(<Box flexDirection="column"><Transcript /><ModsPane
      pane={pane({ type: 'Text', children: ['virtual list'] }, { focused: false, contentRows: 1 })}
      onFocus={async () => ({})} onClose={async () => {}} onInteract={async () => {}}
      onScroll={async (_pane, by, pointer) => { wheels.push({ by, pointer }) }}
    /></Box>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      const body = nodeCache.get(renderedElement(stdout, 'virtual list', 'ink-text'))!
      stdin.push(`\u001b[<65;${body.x + 1};${body.y + 1}M`)
      await settle()
      stdin.push(`\u001b[<64;${body.x + 1};${body.y + 1}M`)
      await settle()
      stdin.push('\u001b[<65;1;1M')
      await settle()
      expect(wheels).toEqual([{ by: 1, pointer: { column: 0, row: 0 } }, { by: -1, pointer: { column: 0, row: 0 } }])
      expect(transcript).toEqual(['down'])
    } finally { instance.unmount() }
  })
})

describe('ModsPane host layout', () => {
  test('keeps the conversation and composer left of the dock across terminal resize', async () => {
    const previous = process.env.CLAUDE_CODE_NO_FLICKER
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    const stdout = new Output()
    stdout.columns = 180
    stdout.rows = 50
    stdout.isTTY = true
    const owner = {}
    const ui = createModUi({
      pluginOf: () => 'fixture',
      dispatch: async (_owner, _event, input, core) => core(input),
      draw: async () => ({ type: 'Text', children: ['DIFF_BODY'] }),
      invokeDrawing: async () => undefined,
      releaseDrawing: async () => {},
    })
    await ui.open(owner, { id: 'diff', title: 'DIFF_TITLE' }, { kind: 'person' }, {
      columns: 180, rows: 50, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false,
    })
    await ui.commit(owner)
    function Content({ label }: { label: string }) {
      const { columns } = useTerminalSize()
      return <Box width={columns}><Text>{label}</Text></Box>
    }
    function Host({ composerRows = 1 }: { composerRows?: number }) {
      const { columns, rows } = useTerminalSize()
      const current = React.useSyncExternalStore(ui.subscribe, ui.getSnapshot)
      useEffect(() => {
        void ui.render({ columns, rows, isFullscreen: true, composerEmpty: true, hasDialog: false, keyboardOwned: false })
      }, [columns, rows])
      const draw = (pane: ModUiPane) => <ModsPane key={pane.id} pane={pane}
        onReportMetrics={(pane, metrics) => ui.reportMetrics(pane.id, metrics)}
        onFocus={async () => ({})} onInteract={async () => {}} onClose={async () => {}} onScroll={async () => {}}
      />
      return <Box width={columns} height={rows} flexDirection="column">
        <FullscreenLayout
          scrollable={<Content label="TRANSCRIPT" />}
          bottom={<Box height={composerRows}><Content label="COMPOSER" /></Box>}
          dockPane={current.filter(pane => pane.placement === 'dock').map(draw)}
          inlinePane={current.filter(pane => pane.placement === 'inline').map(draw)}
        />
      </Box>
    }
    const instance = await render(<Host />, { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      for (const [columns, rows] of [[180, 50], [181, 50], [110, 50], [109, 30], [90, 30], [180, 30], [180, 50]] as const) {
        stdout.columns = columns
        stdout.rows = rows
        stdout.emit('resize')
        await settle()
        const transcript = nodeCache.get(renderedElement(stdout, 'TRANSCRIPT', 'ink-text'))!
        const composer = nodeCache.get(renderedElement(stdout, 'COMPOSER', 'ink-text'))!
        const diff = nodeCache.get(renderedElement(stdout, 'DIFF_BODY', 'ink-text'))!
        const width = columns >= 110 ? Math.ceil(columns / 2) : columns
        expect(domElement(stdout, 'TRANSCRIPT', 'ink-box').yogaNode!.getComputedWidth()).toBe(width)
        expect(domElement(stdout, 'COMPOSER', 'ink-box').yogaNode!.getComputedWidth()).toBe(width)
        expect(transcript.x).toBe(0)
        expect(composer.x).toBe(0)
        expect(composer.y).toBe(rows - 1)
        if (columns >= 110) {
          expect(diff.x).toBe(width)
          expect(diff.y).toBeLessThan(composer.y)
        } else {
          expect(diff.x).toBe(0)
          expect(diff.y).toBeGreaterThan(transcript.y)
          expect(diff.y).toBeLessThan(composer.y)
        }
      }
      for (const composerRows of [8, 25, 1]) {
        instance.rerender(<ThemeProvider><Host composerRows={composerRows} /></ThemeProvider>)
        await settle()
        expect(ui.getSnapshot()[0]!.bodyRows).toBe(50)
        expect(nodeCache.get(renderedElement(stdout, 'COMPOSER', 'ink-text'))!.y).toBe(50 - composerRows)
        expect(domElement(stdout, 'COMPOSER', 'ink-box').yogaNode!.getComputedWidth()).toBe(90)
      }
      await ui.close(owner, 'diff', { kind: 'person' })
      await settle()
      expect(domElement(stdout, 'TRANSCRIPT', 'ink-box').yogaNode!.getComputedWidth()).toBe(180)
      expect(domElement(stdout, 'COMPOSER', 'ink-box').yogaNode!.getComputedWidth()).toBe(180)
      expect(elements(stdout, true).some(element => element.text === 'DIFF_BODY')).toBe(false)
    } finally {
      instance.unmount()
      if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
      else process.env.CLAUDE_CODE_NO_FLICKER = previous
    }
  })

  test('uses the requested Mods dock width while keeping the conversation valid', async () => {
    const previous = process.env.CLAUDE_CODE_NO_FLICKER
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    const stdout = new Output()
    stdout.columns = 180
    stdout.rows = 30
    stdout.isTTY = true
    function Content({ label }: { label: string }) {
      const { columns } = useTerminalSize()
      return <Box width={columns}><Text>{label}:{columns}</Text></Box>
    }
    const draw = (dockWidth: number, withSidebar = false) => (
      <Box width={stdout.columns} height={stdout.rows} flexDirection="column">
        <FullscreenLayout
          scrollable={<Content label="TRANSCRIPT" />}
          bottom={<Content label="COMPOSER" />}
          dockPane={<Content label="DOCK" />}
          dockWidth={dockWidth}
          sidebarPane={withSidebar ? <Content label="SIDEBAR" /> : undefined}
          sidebarWidth={30}
        />
      </Box>
    )
    const instance = await render(draw(42), {
      stdout: stdout as never,
      stdin: new Input() as never,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    try {
      await settle()
      expect(nodeCache.get(renderedElement(stdout, 'TRANSCRIPT:138', 'ink-text'))).toMatchObject({ x: 0 })
      expect(nodeCache.get(renderedElement(stdout, 'COMPOSER:138', 'ink-text'))).toMatchObject({ x: 0 })
      expect(nodeCache.get(renderedElement(stdout, 'DOCK:42', 'ink-text'))).toMatchObject({ x: 138 })

      instance.rerender(<ThemeProvider>{draw(240, true)}</ThemeProvider>)
      await settle()
      expect(domElement(stdout, 'TRANSCRIPT:1', 'ink-box').yogaNode!.getComputedWidth()).toBe(1)
      expect(domElement(stdout, 'SIDEBAR:30', 'ink-box').yogaNode!.getComputedWidth()).toBe(30)
      expect(domElement(stdout, 'DOCK:149', 'ink-box').yogaNode!.getComputedWidth()).toBe(149)
    } finally {
      instance.unmount()
      if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
      else process.env.CLAUDE_CODE_NO_FLICKER = previous
    }
  })

  test('places a native sidebar beside the transcript above a full-width composer', async () => {
    const previous = process.env.CLAUDE_CODE_NO_FLICKER
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    const stdout = new Output()
    stdout.columns = 180
    stdout.rows = 50
    stdout.isTTY = true
    function Content({ label }: { label: string }) {
      const { columns } = useTerminalSize()
      return <Box width={columns}><Text>{label}:{columns}</Text></Box>
    }
    let composerMounts = 0
    function Composer() {
      useEffect(() => { composerMounts++ }, [])
      return <Content label="COMPOSER" />
    }
    function Host({ sidebarOpen }: { sidebarOpen: boolean }) {
      const { columns, rows } = useTerminalSize()
      const sidebarWidth = columns >= 180 ? 81 : 40
      return <Box width={columns} height={rows} flexDirection="column">
        <FullscreenLayout
          scrollable={<Content label="TRANSCRIPT" />}
          bottom={<Composer />}
          sidebarPane={sidebarOpen ? <Content label="SIDEBAR" /> : undefined}
          sidebarWidth={sidebarWidth}
        />
      </Box>
    }
    const instance = await render(<Host sidebarOpen />, {
      stdout: stdout as never,
      stdin: new Input() as never,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    try {
      for (const [columns, rows, sidebarWidth] of [[180, 50, 81], [110, 30, 40]] as const) {
        stdout.columns = columns
        stdout.rows = rows
        stdout.emit('resize')
        await settle()
        const transcriptWidth = columns - sidebarWidth
        const transcript = nodeCache.get(renderedElement(stdout, `TRANSCRIPT:${transcriptWidth}`, 'ink-text'))!
        const sidebar = nodeCache.get(renderedElement(stdout, `SIDEBAR:${sidebarWidth}`, 'ink-text'))!
        const composer = nodeCache.get(renderedElement(stdout, `COMPOSER:${columns}`, 'ink-text'))!
        expect(domElement(stdout, `TRANSCRIPT:${transcriptWidth}`, 'ink-box').yogaNode!.getComputedWidth()).toBe(transcriptWidth)
        expect(domElement(stdout, `SIDEBAR:${sidebarWidth}`, 'ink-box').yogaNode!.getComputedWidth()).toBe(sidebarWidth)
        expect(domElement(stdout, `COMPOSER:${columns}`, 'ink-box').yogaNode!.getComputedWidth()).toBe(columns)
        expect(transcript.x).toBe(0)
        expect(sidebar.x).toBe(transcriptWidth)
        expect(composer.x).toBe(0)
        expect(composer.y).toBe(rows - 1)
      }

      instance.rerender(<ThemeProvider><Host sidebarOpen={false} /></ThemeProvider>)
      await settle()
      expect(domElement(stdout, 'TRANSCRIPT:110', 'ink-box').yogaNode!.getComputedWidth()).toBe(110)
      expect(domElement(stdout, 'COMPOSER:110', 'ink-box').yogaNode!.getComputedWidth()).toBe(110)
      expect(elements(stdout, true).some(element => element.text === 'SIDEBAR:40')).toBe(false)
      expect(composerMounts).toBe(1)
    } finally {
      instance.unmount()
      if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
      else process.env.CLAUDE_CODE_NO_FLICKER = previous
    }
  })

  test('an empty dock does not reserve half of the transcript width', async () => {
    const previous = process.env.CLAUDE_CODE_NO_FLICKER
    process.env.CLAUDE_CODE_NO_FLICKER = '1'
    const stdout = new Output()
    stdout.columns = 160
    const instance = await render(
      <Box width={160} height={30} flexDirection="column">
        <FullscreenLayout
          scrollable={<Box width="100%"><Text>TRANSCRIPT</Text></Box>}
          bottom={<Text>COMPOSER</Text>}
          dockPane={[]}
          inlinePane={[]}
        />
      </Box>,
      { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false },
    )
    try {
      await settle()
      expect(domElement(stdout, 'TRANSCRIPT', 'ink-box').yogaNode!.getComputedWidth()).toBe(160)
    } finally {
      instance.unmount()
      if (previous === undefined) delete process.env.CLAUDE_CODE_NO_FLICKER
      else process.env.CLAUDE_CODE_NO_FLICKER = previous
    }
  })
})

describe('ModsPane Ink interaction', () => {
  test.each([
    { path: 'Dockerfile', source: 'FROM alpine', token: 'FROM' },
    { path: 'script', source: '#!/usr/bin/env python\nreturn True', token: 'return' },
    { path: 'source.ts', source: 'const result = true', token: 'const' },
  ])('Code infers language from $path or its shebang', async ({ path, source, token }) => {
    const level = chalk.level
    chalk.level = 3
    const stdout = new Output()
    const instance = await modsPane({ type: 'Code', props: { path, source } }, stdout)
    try {
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(stripAnsi(stdout.output)).toContain(source)
      expect(elements(stdout, false).some(({ node, text }) => text === token && node.textStyles?.color !== undefined)).toBe(true)
    } finally { instance.unmount(); chalk.level = level }
  })

  test('Code keeps multiline syntax colour across numbered source lines', async () => {
    const level = chalk.level
    chalk.level = 3
    const stdout = new Output()
    const instance = await modsPane({ type: 'Code', props: { source: '/* first\nsecond\n*/', language: 'ts', startLine: 20 } }, stdout)
    try {
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(stripAnsi(stdout.output)).toContain('20 /* first\n21 second\n22 */')
      const coloured = (text: string) => elements(stdout, false).find(({ node, text: content }) => content === text && node.textStyles?.color !== undefined)?.node.textStyles?.color
      expect(coloured('/* first')).toBeDefined()
      expect(coloured('second')).toEqual(coloured('/* first'))
    } finally { instance.unmount(); chalk.level = level }
  })

  test('Code language overrides path, unknown language stays plain, and path is never displayed', async () => {
    const level = chalk.level
    chalk.level = 3
    const stdout = new Output()
    const draw = (language: string) => <ModsPane pane={pane({ type: 'Code', props: {
      source: 'const answer = true', language, path: '/not-read/source.md',
    } })} onInteract={async () => {}} onFocus={async () => ({})} onScroll={async () => ({})} onClose={async () => {}} />
    const instance = await render(draw('ts'), { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      expect(stripAnsi(stdout.output)).toContain('const answer = true')
      expect(stripAnsi(stdout.output)).not.toContain('/not-read/source.md')
      expect(elements(stdout, false).some(({ node, text }) => text === 'const' && node.textStyles?.color !== undefined)).toBe(true)
      instance.rerender(<ThemeProvider>{draw('not-a-language')}</ThemeProvider>)
      await settle()
      expect(elements(stdout, false).some(({ node }) => node.nodeName === 'ink-virtual-text' && node.textStyles?.color !== undefined)).toBe(false)
    } finally { instance.unmount(); chalk.level = level }
  })

  test.each([false, true])('Code diff truncate-end keeps hunk numbers and markers without wrapping (highlight disabled=%s)', async disabled => {
    const previous = process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT
    if (disabled) process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT = '0'
    const stdout = new Output()
    const store = createStore(getDefaultAppState())
    const instance = await render(<AppStoreContext.Provider value={store}><ModsPane
      pane={pane({ type: 'Box', props: { width: 12 }, children: [{ type: 'Code', props: {
        source: '@@ -9,2 +20,2 @@\n-abcdefghijklmno\n+ABCDEFGHIJKLMNO\n same\n', format: 'diff', wrap: 'truncate-end', startLine: 300,
      } }] })}
      onInteract={async () => {}} onFocus={async () => ({})} onScroll={async () => ({})} onClose={async () => {}}
    /></AppStoreContext.Provider>, { stdout: stdout as never, stdin: new Input() as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      expect(stripAnsi(stdout.output)).toContain('  9 -abcdef…\n 20 +ABCDEF…\n 21  same')
      expect(stripAnsi(stdout.output)).not.toContain('300')
    } finally {
      instance.unmount()
      if (previous === undefined) delete process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT
      else process.env.CLAUDE_CODE_SYNTAX_HIGHLIGHT = previous
    }
  })

  test.each(['wrap', 'truncate-end'] as const)('Code wrap=%s paints within nested width under the gutter', async wrap => {
    const stdout = new Output()
    const instance = await modsPane({ type: 'Box', props: { width: 8 }, children: [
      { type: 'Code', props: { source: 'abcdefghij\n尾部', startLine: 9, wrap } },
    ] }, stdout)
    try {
      await settle()
      expect(stripAnsi(stdout.output)).toContain(wrap === 'wrap'
        ? ' 9 abcde\n   fghij\n10 尾部'
        : ' 9 abcd…\n10 尾部')
    } finally { instance.unmount() }
  })

  test('Code without language or path stays plain with no implicit markdown or gutter', async () => {
    const level = chalk.level
    chalk.level = 3
    const stdout = new Output()
    const instance = await modsPane({ type: 'Code', props: { source: '**plain**\nlast' } }, stdout)
    try {
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(stripAnsi(stdout.output)).toContain('**plain**\nlast')
      expect(elements(stdout, false).some(({ node }) => node.nodeName === 'ink-virtual-text' && (node.textStyles?.bold || node.textStyles?.color))).toBe(false)
    } finally { instance.unmount(); chalk.level = level }
  })

  test('Code startLine paints a dim right-aligned gutter and preserves empty source lines', async () => {
    const stdout = new Output()
    const instance = await modsPane({ type: 'Code', props: { source: 'alpha\n\nomega', startLine: 9 } }, stdout)
    try {
      await settle()
      expect(stripAnsi(stdout.output)).toContain(' 9 alpha\n10\n11 omega')
      const nine = renderedElement(stdout, '9', 'ink-text')
      const eleven = renderedElement(stdout, '11', 'ink-text')
      expect(nodeCache.get(nine)!.x + nodeCache.get(nine)!.width).toBe(nodeCache.get(eleven)!.x + nodeCache.get(eleven)!.width)
      expect(nine.textStyles?.color).toBeDefined()
    } finally { instance.unmount() }
  })

  test('omits the title for one pane and gives the full height to its body', async () => {
    const stdout = new Output()
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Text', children: ['PANE_BODY_COUNT_0'] },
        ...Array.from({ length: 12 }, (_, index) => ({
          type: 'Text', children: [`PANE_SCROLL_ROW_${String(index + 1).padStart(2, '0')}`],
        })),
      ],
    }
    const instance = await modsPane(tree, stdout)
    try {
      await settle()
      expect(elements(stdout, true).some(element => element.text === 'Test')).toBe(false)
      const body = nodeCache.get(renderedElement(stdout, 'PANE_BODY_COUNT_0', 'ink-text'))
      const scroller = elements(stdout, true)
        .find(element => element.node.nodeName === 'ink-box' && element.node.style.overflowY === 'scroll')
      const viewport = scroller && nodeCache.get(scroller.node)
      assert.ok(body && viewport)
      expect({
        body: body.y,
        viewport: { y: viewport.y, height: viewport.height },
      }).toEqual({
        body: 0,
        viewport: { y: 0, height: 10 },
      })
    } finally {
      instance.unmount()
    }
  })

  test('reports real keyed rows and keeps the first duplicate in document order', async () => {
    const stdout = new Output()
    const reports: { keyRows?: readonly { plugin: string; key: string; top: number; bottom: number }[] }[] = []
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Text', children: ['before'] },
        { type: 'Box', props: { key: 'target', height: 2 }, group: { plugin: 'fixture' }, children: [
          { type: 'Text', children: ['first target'] },
        ] },
        { type: 'Box', props: { key: 'target', height: 3 }, group: { plugin: 'fixture' }, children: [
          { type: 'Text', children: ['second target'] },
        ] },
      ],
    }
    const instance = await render(
      <ModsPane
        pane={pane(tree)}
        onInteract={async () => {}}
        onClose={async () => {}}
        onFocus={async () => ({})}
        onScroll={async () => ({})}
        onReportMetrics={(_pane, metrics) => { reports.push(metrics) }}
      />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new Input() as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await settle()
      expect(reports.at(-1)?.keyRows).toEqual([
        { plugin: 'fixture', key: 'target', top: 1, bottom: 3 },
      ])
    } finally {
      instance.unmount()
    }
  })

  test('focuses the first duplicate key in document order', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const interactions: string[] = []
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Button', props: { key: 'duplicate', label: 'First' }, press: { plugin: 'fixture', handle: 1 } },
        { type: 'Button', props: { key: 'duplicate', label: 'Second' }, press: { plugin: 'fixture', handle: 2 } },
      ],
    }
    const instance = await render(
      <>
        <EnableInput />
        <ModsPane
          pane={pane(tree, { focusedElement: 'duplicate' })}
          onInteract={async (_pane, _drawing, callback) => { interactions.push(String(callback.handle)) }}
          onClose={async () => {}}
          onFocus={async () => ({})}
          onScroll={async () => ({})}
        />
      </>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await settle()
      stdin.push('\r')
      await settle()
      expect(interactions).toEqual(['1'])
    } finally {
      instance.unmount()
    }
  })

  test('renders text/code and sends Button Enter and Select arrows through drawing callbacks', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const interactions: { kind: string; element: string; value?: string }[] = []
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Text', props: { bold: true }, children: ['Plugin pane'] },
        { type: 'Button', props: { key: 'run', label: 'Run', autoFocus: true }, press: { plugin: 'fixture', handle: 11 } },
        { type: 'Select', props: { key: 'base', label: 'Base', value: 'main', options: [{ value: 'main', label: 'Main' }, { value: 'dev', label: 'Develop' }] }, press: { plugin: 'fixture', handle: 12 } },
        { type: 'Code', props: { source: 'const answer = 42', path: 'sample.ts' } },
      ],
    }
    const instance = await render(
      <>
        <EnableInput />
        <ModsPane
          pane={pane(tree)}
          onInteract={async (_pane, _drawing, _press, kind, element, value) => {
            interactions.push({ kind, element, ...(value === undefined ? {} : { value }) })
          }}
          onClose={async () => {}}
          onFocus={async () => ({})}
          onScroll={async () => ({})}
        />
      </>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await settle()
      assert.match(stripAnsi(stdout.output), /Plugin pane/)
      assert.match(stripAnsi(stdout.output), /const answer = 42/)
      stdin.push('\r')
      await settle()
      stdin.push('\t')
      await settle()
      stdin.push('\u001b[B')
      await settle()
      stdin.push('\r')
      await settle()
      expect(interactions).toEqual([
        { kind: 'press', element: 'run' },
        { kind: 'select', element: 'base', value: 'dev' },
      ])
    } finally {
      instance.unmount()
    }
  })

  test.each([
    { label: 'Down + Enter', chunk: '\u001b[B\r', value: 'dev' },
    { label: 'multiple Down + Space', chunk: '\u001b[B\u001b[B ', value: 'release' },
    { label: 'Down wraparound + Enter', chunk: '\u001b[B'.repeat(4) + '\r', value: 'dev' },
    { label: 'Up wraparound + Space', chunk: '\u001b[A ', value: 'release' },
    { label: 'multiple Up + Enter', chunk: '\u001b[A\u001b[A\r', value: 'dev' },
    { label: 'mixed arrows + Space', chunk: '\u001b[B\u001b[A\u001b[A ', value: 'release' },
    { label: 'Down + click', chunk: '\u001b[B', value: 'dev', click: true },
  ])('Select submits the new value once for $label in one stdin chunk', async sample => {
    const { value } = sample
    let { chunk } = sample
    const stdout = new Output()
    const stdin = new Input()
    const current = pane({
      type: 'Select',
      props: { key: 'base', value: 'main', options: [{ value: 'main' }, { value: 'dev' }, { value: 'release' }] },
      press: { plugin: 'fixture', handle: 2 },
    }, { focusedElement: 'base' })
    const selections: unknown[][] = []
    const instance = await render(<><EnableInput /><ModsPane
      pane={current}
      onInteract={async (...args) => { selections.push(args) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      const select = renderedElement(stdout, 'main ↑↓', 'ink-text').parentNode!
      expect(getFocusManager(select).activeElement).toBe(select)
      if ('click' in sample) {
        const ink = instances.get(stdout as never) as unknown as InkInstance
        ink.setAltScreenActive(true, true)
        const rect = nodeCache.get(select)!
        chunk += `\u001b[<0;${rect.x + 1};${rect.y + 1}M\u001b[<0;${rect.x + 1};${rect.y + 1}m`
      }
      stdin.push(chunk)
      await settle()
      expect(selections).toEqual([[current, 7, { plugin: 'fixture', handle: 2 }, 'select', 'base', value]])
      expect(renderedElement(stdout, `${value} ↑↓`, 'ink-text').parentNode).toBe(select)
      expect(getFocusManager(select).activeElement).toBe(select)
    } finally { instance.unmount() }
  })

  test('Select applies explicit values on each drawing without resetting picks on snapshot publishes', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const selections: { drawing: number; value?: string }[] = []
    let drawing = 7
    let revision = 0
    let focused = true
    let value: string | undefined = 'main'
    const draw = () => <><EnableInput /><ModsPane
      pane={pane({ type: 'Select', props: { key: 'base', value, options: [{ value: 'main' }, { value: 'dev' }, { value: 'release' }] }, press: { plugin: 'fixture', handle: 2 } }, {
        owner, drawing, revision, focused, focusedElement: 'base', bodyRows: 10 + revision,
      })}
      onInteract={async (_pane, drawing, _press, _kind, _element, value) => { selections.push({ drawing, value }) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      const select = renderedElement(stdout, 'main ↑↓', 'ink-text').parentNode!
      stdin.push('\u001b[B')
      await settle()
      for (const nextFocus of [false, true]) {
        focused = nextFocus
        revision++
        instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
        await settle()
        expect(renderedElement(stdout, 'dev ↑↓', 'ink-text').parentNode).toBe(select)
      }
      stdin.push('\r')
      await settle()
      expect(selections).toEqual([{ drawing, value: 'dev' }])
      for (const [nextValue, expected, nextPick] of [
        ['main', 'main', 'dev'], ['release', 'release', 'main'], [undefined, 'main', 'dev'],
      ] as const) {
        value = nextValue
        drawing++
        instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
        await settle()
        expect(renderedElement(stdout, `${expected} ↑↓`, 'ink-text').parentNode).toBe(select)
        expect(getFocusManager(select).activeElement).toBe(select)
        const count = selections.length
        stdin.push('\r\u001b[B\r')
        await settle()
        expect(selections.slice(count)).toEqual([{ drawing, value: expected }, { drawing, value: nextPick }])
        expect(renderedElement(stdout, `${nextPick} ↑↓`, 'ink-text').parentNode).toBe(select)
        expect(getFocusManager(select).activeElement).toBe(select)
      }
    } finally { instance.unmount() }
  })

  test('Select clamps its current index when a drawing shortens options or deletes the selected option', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const selections: (string | undefined)[] = []
    let drawing = 7
    const draw = (values: string[]) => <><EnableInput /><ModsPane
      pane={pane({ type: 'Select', props: { key: 'base', options: values.map(value => ({ value })) }, press: { plugin: 'fixture', handle: 2 } }, {
        owner, drawing, focusedElement: 'base',
      })}
      onInteract={async (_pane, _drawing, _press, _kind, _element, value) => { selections.push(value) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></>
    const instance = await render(draw(['main', 'dev', 'release']), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      const select = renderedElement(stdout, 'main ↑↓', 'ink-text').parentNode!
      stdin.push('\u001b[A')
      await settle()
      expect(renderedElement(stdout, 'release ↑↓', 'ink-text').parentNode).toBe(select)
      for (const values of [['main', 'dev'], ['main', 'replacement'], ['only']]) {
        drawing++
        instance.rerender(<ThemeProvider>{draw(values)}</ThemeProvider>)
        await settle()
        assert.ok(instances.get(stdout as never), stripAnsi(stdout.output))
        expect(renderedElement(stdout, `${values.at(-1)} ↑↓`, 'ink-text').parentNode).toBe(select)
        expect(getFocusManager(select).activeElement).toBe(select)
        const count = selections.length
        stdin.push('\r\u001b[B\r\u001b[A ')
        await settle()
        expect(selections.slice(count)).toEqual([values.at(-1), values[0], values.at(-1)])
        expect(renderedElement(stdout, `${values.at(-1)} ↑↓`, 'ink-text').parentNode).toBe(select)
        expect(getFocusManager(select).activeElement).toBe(select)
      }
      stdin.push('\u001b[B\r')
      await settle()
      expect(selections).toEqual(['dev', 'main', 'dev', 'replacement', 'main', 'replacement', 'only', 'only', 'only', 'only'])
    } finally { instance.unmount() }
  })

  test('Input keeps cached typing across unrelated drawings and only applies a genuinely new explicit value', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const owner = {}
    const interactions: { drawing: number; kind: string; value?: string }[] = []
    let drawing = 7
    let revision = 0
    let value: string | undefined = 'seed'
    const draw = () => <><EnableInput /><ModsPane
      pane={pane({ type: 'Input', props: { key: 'reply', value, placeholder: 'Empty' }, press: { plugin: 'fixture', handle: 2 } }, {
        owner, drawing, revision, focusedElement: 'reply', bodyRows: 10 + revision,
      })}
      onInteract={async (_pane, drawing, _press, kind, _element, value) => { interactions.push({ drawing, kind, value }) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></>
    const instance = await render(draw(), { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      const input = renderedElement(stdout, 'seed', 'ink-text').parentNode!
      stdin.push('-edited')
      await settle()

      revision++
      drawing++
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(renderedElement(stdout, 'seed-edited', 'ink-text').parentNode).toBe(input)
      expect(getFocusManager(input).activeElement).toBe(input)
      stdin.push('\r')
      await settle()
      expect(interactions.at(-1)).toEqual({ drawing, kind: 'input.submit', value: 'seed-edited' })

      value = 'replacement'
      drawing++
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(renderedElement(stdout, 'replacement', 'ink-text').parentNode).toBe(input)
      expect(getFocusManager(input).activeElement).toBe(input)
      stdin.push('\r')
      await settle()
      expect(interactions.at(-1)).toEqual({ drawing, kind: 'input.submit', value: 'replacement' })

      value = undefined
      drawing++
      instance.rerender(<ThemeProvider>{draw()}</ThemeProvider>)
      await settle()
      expect(renderedElement(stdout, 'Empty', 'ink-text').parentNode).toBe(input)
      stdin.push('\r')
      await settle()
      expect(interactions.at(-1)).toEqual({ drawing, kind: 'input.submit', value: '' })
    } finally { instance.unmount() }
  })

  test('Input navigation and deletion preserve complete grapheme clusters', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const interactions: { kind: string; value?: string }[] = []
    const instance = await render(<><EnableInput /><ModsPane
      pane={pane({ type: 'Input', props: { key: 'reply', value: 'A👨‍👩‍👧‍👦B', autoFocus: true }, press: { plugin: 'fixture', handle: 2 } })}
      onInteract={async (_pane, _drawing, _press, kind, _element, value) => { interactions.push({ kind, value }) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      stdin.push('\u001b[D\u007f\u001b[H\u001b[C\u001b[3~\r')
      await settle()
      expect(interactions).toEqual([
        { kind: 'input.change', value: 'AB' },
        { kind: 'input.change', value: 'A' },
        { kind: 'input.submit', value: 'A' },
      ])
    } finally { instance.unmount() }
  })

  test('Input edits and submits at the cursor with real navigation, Home, End, Backspace and Delete events', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const interactions: { kind: string; value?: string }[] = []
    const instance = await render(<><EnableInput /><ModsPane
      pane={pane({ type: 'Input', props: { key: 'reply', value: 'abcd', autoFocus: true }, press: { plugin: 'fixture', handle: 2 } })}
      onInteract={async (_pane, _drawing, _press, kind, _element, value) => { interactions.push({ kind, value }) }}
      onFocus={async () => ({})} onClose={async () => {}} onScroll={async () => ({})}
    /></>, { stdout: stdout as never, stdin: stdin as never, patchConsole: false, exitOnCtrlC: false })
    try {
      await settle()
      const input = renderedElement(stdout, 'abcd', 'ink-text').parentNode!
      expect(getFocusManager(input).activeElement).toBe(input)
      for (const chunk of ['\u001b[D', '\u001b[D', 'X', '\u001b[H', '\u001b[3~', '\u001b[F', '\u007f', '\r']) {
        stdin.push(chunk)
        await settle()
      }
      expect(interactions).toEqual([
        { kind: 'input.change', value: 'abXcd' },
        { kind: 'input.change', value: 'bXcd' },
        { kind: 'input.change', value: 'bXc' },
        { kind: 'input.submit', value: 'bXc' },
      ])
      expect(renderedElement(stdout, 'bXc', 'ink-text').parentNode).toBe(input)
      expect(getFocusManager(input).activeElement).toBe(input)
    } finally { instance.unmount() }
  })

  test('distinguishes Input changes/submits and applies requested element focus', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const interactions: { kind: string; value?: string }[] = []
    const focused: (string | undefined)[] = []
    const tree = {
      type: 'Box', props: { flexDirection: 'column' }, children: [
        { type: 'Button', props: { key: 'first', label: 'First', autoFocus: true }, press: { plugin: 'fixture', handle: 1 } },
        { type: 'Input', props: { key: 'reply', value: 'a' }, press: { plugin: 'fixture', handle: 2 } },
      ],
    }
    const renderPane = (focusedElement?: string) => (
      <>
        <EnableInput />
        <ModsPane
          pane={pane(tree, focusedElement === undefined ? {} : { focusedElement })}
          onInteract={async (_pane, _drawing, _press, kind, _element, value) => {
            interactions.push({ kind, ...(value === undefined ? {} : { value }) })
          }}
          onClose={async () => {}}
          onFocus={async (_pane, element) => { focused.push(element); return {} }}
          onScroll={async () => ({})}
        />
      </>
    )
    const instance = await render(renderPane(), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    try {
      await settle()
      focused.length = 0
      instance.rerender(renderPane('reply'))
      await settle()
      const input = renderedElement(stdout, 'a', 'ink-text').parentNode!
      expect(getFocusManager(input).activeElement).toBe(input)
      stdin.push('b')
      await settle()
      stdin.push('\r')
      await settle()
      expect(interactions).toEqual([
        { kind: 'input.change', value: 'ab' },
        { kind: 'input.submit', value: 'ab' },
      ])
      expect(focused).toEqual([])
    } finally {
      instance.unmount()
    }
  })

  test.each([
    { label: 'bulk input', chunks: ['sample-input\r'], values: ['sample-input'] },
    { label: 'CJK input', chunks: ['中文输入\r'], values: ['中文输入'] },
    { label: 'backspace in a bulk chunk', chunks: ['abc\u007f\r'], values: ['abc', 'ab'] },
    { label: 'empty paste', chunks: ['\u001b[200~\u001b[201~\r'], values: [''] },
    { label: 'literal key names', chunks: ['return', 'tab', 'backspace', 'delete', 'up', '\r'], values: ['return', 'returntab', 'returntabbackspace', 'returntabbackspacedelete', 'returntabbackspacedeleteup'] },
    { label: 'bracketed paste', chunks: ['\u001b[200~paste\r\t中文\u001b[201~\r'], values: ['paste\r\t中文'] },
    { label: 'split bracketed paste', chunks: ['\u001b[200~ret', 'urn\u001b[201~\r'], values: ['return'] },
    { label: 'immediate submit after typing', chunks: ['a', 'b', '\r'], values: ['a', 'ab'] },
    { label: 'special keys are not text', chunks: ['\u001b[A\u001b[B\u001b[C\u001b[D\u001b[H\u001b[F\u001bOP\u001b[25~\u001b[57358u\u0001\u001bx\u001b[97;9u\r'], values: [] },
    { label: 'encoded printable keys', chunks: ['\u001b[97u\u001b[32u\u001b[27;1;98~\u001bOp\r'], values: ['a', 'a ', 'a b', 'a b0'] },
  ])('preserves Input text and submit ordering for $label through stdin', async ({ chunks, values }) => {
    const stdout = new Output()
    const stdin = new Input()
    const interactions: { kind: string; value?: string }[] = []
    const instance = await render(
      <>
        <EnableInput />
        <ModsPane
          pane={pane({ type: 'Input', props: { key: 'reply', autoFocus: true }, press: { plugin: 'fixture', handle: 2 } })}
          onInteract={async (_pane, _drawing, _press, kind, _element, value) => {
            interactions.push({ kind, value })
          }}
          onClose={async () => {}}
          onFocus={async () => ({})}
          onScroll={async () => ({})}
        />
      </>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await settle()
      for (const chunk of chunks) {
        stdin.push(chunk)
        stdin.emit('readable')
      }
      await settle()
      expect(interactions).toEqual([
        ...values.map(value => ({ kind: 'input.change', value })),
        { kind: 'input.submit', value: values.at(-1) ?? '' },
      ])
    } finally {
      instance.unmount()
    }
  })

  test('uses real Tab for Input focus traversal without inserting text', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const interactions: string[] = []
    const instance = await render(
      <>
        <EnableInput />
        <ModsPane
          pane={pane({ type: 'Box', children: [
            { type: 'Input', props: { key: 'reply', autoFocus: true }, press: { plugin: 'fixture', handle: 1 } },
            { type: 'Button', props: { key: 'run', label: 'Run' }, press: { plugin: 'fixture', handle: 2 } },
          ] })}
          onInteract={async (_pane, _drawing, _press, kind, element) => { interactions.push(`${kind}:${element}`) }}
          onClose={async () => {}}
          onFocus={async () => ({})}
          onScroll={async () => ({})}
        />
      </>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await settle()
      stdin.push('\t')
      await settle()
      stdin.push('\r')
      await settle()
      expect(interactions).toEqual(['press:run'])
    } finally {
      instance.unmount()
    }
  })

  test('does not take keyboard focus when the service denied pane focus', async () => {
    const stdout = new Output()
    const stdin = new Input()
    let outerKeys = ''
    const calls: string[] = []
    const instance = await render(
      <>
        <EnableInput />
        <ink-box tabIndex={0} autoFocus onKeyDown={(event: { key: string }) => { outerKeys += event.key }} />
        <ModsPane
          pane={pane({ type: 'Button', props: { key: 'run', label: 'Run', autoFocus: true }, press: { plugin: 'fixture', handle: 1 } }, { focused: false })}
          onInteract={async () => { calls.push('pressed') }}
          onClose={async () => {}}
          onFocus={async () => ({})}
          onScroll={async () => ({})}
        />
      </>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await settle()
      stdin.push('\r')
      await settle()
      expect(calls).toEqual([])
      expect(outerKeys).toContain('return')
    } finally {
      instance.unmount()
    }
  })

  test('releases DOM focus after a non-closing Escape relinquishes the pane', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const tree = { type: 'Button', props: { key: 'run', label: 'Run', autoFocus: true }, press: { plugin: 'fixture', handle: 1 } }
    const renderPane = (focused: boolean) => (
      <>
        <EnableInput />
        <ink-box tabIndex={0} />
        <ModsPane
          pane={pane(tree, { focused })}
          onInteract={async () => {}}
          onClose={async () => {}}
          onFocus={async () => {
            instance.rerender(renderPane(false))
            return {}
          }}
          onScroll={async () => ({})}
        />
      </>
    )
    const instance = await render(renderPane(true), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    })
    try {
      await settle()
      const button = renderedElement(stdout, '[ Run ]', 'ink-text').parentNode!
      const manager = getFocusManager(button)
      expect(manager.activeElement).not.toBeNull()
      stdin.push('\u001b')
      await settle()
      expect(manager.activeElement).toBeNull()
    } finally {
      instance.unmount()
    }
  })

  test('routes focused scrolling and Escape through service operations', async () => {
    const stdout = new Output()
    const stdin = new Input()
    const scroll: number[] = []
    let closes = 0
    const instance = await render(
      <>
        <EnableInput />
        <ModsPane
          pane={pane({ type: 'Text', children: ['body'] }, { closeOnEscape: true })}
          onInteract={async () => {}}
          onClose={async () => { closes++ }}
          onFocus={async () => ({})}
          onScroll={async (_pane, by) => { scroll.push(by); return {} }}
        />
      </>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    )
    try {
      await settle()
      stdin.push('\u001b[B')
      await settle()
      stdin.push('\u001b[6~')
      await settle()
      stdin.push('\u001b')
      await settle()
      expect(scroll).toEqual([1, 10])
      expect(closes).toBe(1)
    } finally {
      instance.unmount()
    }
  })
})
