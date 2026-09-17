import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { describe, expect, test } from 'bun:test'
import React, { useEffect } from 'react'
import stripAnsi from 'strip-ansi'
import { render, useStdin } from '../ink.js'
import type { DOMElement, DOMNode } from '../ink/dom.js'
import { getFocusManager } from '../ink/focus.js'
import instances from '../ink/instances.js'
import { nodeCache } from '../ink/node-cache.js'
import { ModsPane, validateModRenderTree } from './ModsPane.js'
import type { ModUiPane } from '../services/mods/ui.js'

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
    placement: 'inline',
    focused: true,
    closeOnEscape: false,
    holdToasts: false,
    scrollOffset: 0,
    bodyRows: 10,
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
    expect(() => validateModRenderTree({ type: 'Box', props: { position: 'absolute' } })).toThrow(/prop/i)
    expect(() => validateModRenderTree({ type: 'Button', props: { key: 'x', label: 'X' }, press: { plugin: 'fixture', handle: 0 } })).toThrow(/handle/i)
    expect(() => validateModRenderTree({ type: 'Code', props: { source: 'x'.repeat(10_001) } })).toThrow(/10000/i)
    expect(() => validateModRenderTree({ type: 'Code', props: { source: 'not a patch', format: 'diff' } })).toThrow(/hunk/i)
    expect(() => validateModRenderTree({ type: 'Text', children: ['\u001b[31mraw ansi'] })).toThrow(/control/i)
    expect(() => validateModRenderTree({ type: 'Box', children: Array.from({ length: 2_001 }, () => 'x') })).toThrow(/node/i)
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
    })).toThrow(/scope.*display/i)
    expect(() => validateModRenderTree({
      type: 'Text',
      children: ['label'],
      hover: { scope: 'shared', bold: true },
      group: { plugin: '' },
    })).toThrow(/plugin/i)
  })
})

describe('ModsPane terminal hover', () => {
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
          }, { id: 'peers' })}
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

describe('ModsPane Ink interaction', () => {
  test('keeps the pane title above the scrollable body', async () => {
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
      const title = nodeCache.get(renderedElement(stdout, 'Test', 'ink-text'))
      const body = nodeCache.get(renderedElement(stdout, 'PANE_BODY_COUNT_0', 'ink-text'))
      const scroller = elements(stdout, true)
        .find(element => element.node.nodeName === 'ink-box' && element.node.style.overflowY === 'scroll')
      const viewport = scroller && nodeCache.get(scroller.node)
      assert.ok(title && body && viewport)
      expect({
        title: { y: title.y, height: title.height },
        body: body.y,
        viewport: { y: viewport.y, height: viewport.height },
      }).toEqual({
        title: { y: 0, height: 1 },
        body: 1,
        viewport: { y: 1, height: 10 },
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
      instance.rerender(renderPane('reply'))
      await settle()
      stdin.push('b')
      await settle()
      stdin.push('\r')
      await settle()
      expect(interactions).toEqual([
        { kind: 'input.change', value: 'ab' },
        { kind: 'input.submit', value: 'ab' },
      ])
      expect(focused).toContain('reply')
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
