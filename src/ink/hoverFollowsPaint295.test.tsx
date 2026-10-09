import { expect, spyOn, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import render from './root.js'
import instances from './instances.js'
import type { DOMElement } from './dom.js'
import { appendChildNode, createNode, removeChildNode } from './dom.js'
import { dispatchHover, followHover } from './hit-test.js'
import { nodeCache } from './node-cache.js'
import Button from './components/Button.js'
import Box from './components/Box.js'
import Text from './components/Text.js'
import { AlternateScreen } from './components/AlternateScreen.js'
import useInput from './hooks/use-input.js'

function streams() {
  const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }),
    { columns: 80, rows: 24, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }),
    { isTTY: true, isRaw: false, setRawMode() { return this }, ref() { return this }, unref() { return this } }) as unknown as NodeJS.ReadStream
  return { stdout, stdin }
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 500
  while (!predicate() && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve))
  expect(predicate()).toBe(true)
}

for (const initiallyUnderPointer of [true, false]) {
  test(`stationary pointer ${initiallyUnderPointer ? 'leaves a moved' : 'enters an arriving'} Button after paint`, async () => {
    let hovered = false
    let element: DOMElement | null = null
    let frames = 0
    const { stdout, stdin } = streams()
    const tree = (left: number) => <AlternateScreen><Button ref={value => { element = value }}
      marginLeft={left} onAction={() => {}}>{state => {
        hovered = state.hovered
        return <Text>{state.hovered ? 'HOVER' : 'IDLE'}</Text>
      }}</Button></AlternateScreen>
    const app = await render(tree(initiallyUnderPointer ? 0 : 12), {
      stdout, stdin, patchConsole: false, exitOnCtrlC: false, onFrame() { frames++ },
    })
    try {
      const ink = instances.get(stdout)!
      expect(nodeCache.get(element!)!.x).toBe(initiallyUnderPointer ? 0 : 12)
      ink.dispatchHover(1, 0)
      app.rerender(tree(initiallyUnderPointer ? 0 : 12))
      expect(hovered).toBe(initiallyUnderPointer)
      const before = frames
      app.rerender(tree(initiallyUnderPointer ? 12 : 0))
      expect(nodeCache.get(element!)!.x).toBe(initiallyUnderPointer ? 12 : 0)
      expect(frames).toBeGreaterThan(before)
      await until(() => hovered === !initiallyUnderPointer)
    } finally {
      app.unmount()
      app.cleanup()
    }
  })
}

test('paint reconciles opted-in ancestors once, preserves ordinary hover, and skips detached leave handlers', () => {
  const root = createNode('ink-root'), ordinary = createNode('ink-box'), parent = createNode('ink-box'), child = createNode('ink-text')
  appendChildNode(root, ordinary)
  appendChildNode(root, parent)
  appendChildNode(parent, child)
  nodeCache.set(root, { x: 0, y: 0, width: 40, height: 2 })
  nodeCache.set(ordinary, { x: 0, y: 0, width: 10, height: 1 })
  for (const node of [parent, child]) nodeCache.set(node, { x: 12, y: 0, width: 10, height: 1 })
  parent.attributes.hoverFollowsPaint = true
  child.attributes.hoverFollowsPaint = true
  const events: string[] = []
  for (const [name, node] of [['ordinary', ordinary], ['parent', parent], ['child', child]] as const)
    node._eventHandlers = { onMouseEnter: () => events.push(name + ':enter'), onMouseLeave: () => events.push(name + ':leave') }
  const hovered = new Set<DOMElement>()
  dispatchHover(root, 1, 0, hovered)
  expect(events).toEqual(['ordinary:enter'])
  for (const node of [parent, child]) nodeCache.set(node, { x: 0, y: 0, width: 10, height: 1 })
  expect(followHover(root, 1, 0, hovered)).toBe(true)
  expect(events).toEqual(['ordinary:enter', 'child:enter', 'parent:enter'])
  expect(hovered.has(ordinary)).toBe(true)
  expect(followHover(root, 1, 0, hovered)).toBe(false)
  removeChildNode(parent, child)
  nodeCache.set(parent, { x: 12, y: 0, width: 10, height: 1 })
  expect(followHover(root, 1, 0, hovered)).toBe(true)
  expect(events).toEqual(['ordinary:enter', 'child:enter', 'parent:enter', 'parent:leave'])
  expect([...hovered]).toEqual([ordinary])
})

for (const afterPaint of [false, true]) {
  test(`${afterPaint ? 'paint' : 'motion'} excludes blank cells for hoverIgnoresBlankCells nodes`, () => {
    const root = createNode('ink-root'), node = createNode('ink-box')
    appendChildNode(root, node)
    for (const entry of [root, node]) nodeCache.set(entry, { x: 0, y: 0, width: 12, height: 1 })
    node.attributes.hoverIgnoresBlankCells = true
    node.attributes.hoverFollowsPaint = true
    const events: string[] = []
    node._eventHandlers = { onMouseEnter: () => events.push('enter'), onMouseLeave: () => events.push('leave') }
    const hovered = new Set<DOMElement>(afterPaint ? [node] : [])
    Reflect.apply(afterPaint ? followHover : dispatchHover, undefined, [root, 1, 0, hovered, true])
    expect(hovered.size).toBe(0)
    expect(events).toEqual(afterPaint ? ['leave'] : [])
  })
}

test('a blank gap between glyphs in the same painted Text is not an empty click target', async () => {
  const { stdout, stdin } = streams()
  let empty: boolean | undefined
  const app = await render(<AlternateScreen><Box onClick={event => { empty = event.cellIsBlank }}>
    <Text>A B</Text>
  </Box></AlternateScreen>, { stdout, stdin, patchConsole: false, exitOnCtrlC: false })
  try {
    expect(instances.get(stdout)!.dispatchMouseClick(1, 0)).toBe('handled')
    expect(empty).toBe(false)
  } finally {
    app.unmount()
    app.cleanup()
  }
})

test('Box blank-cell hover excludes outside spaces but keeps a gap in one Text and rejects gaps across separate Text nodes', async () => {
  const { stdout, stdin } = streams()
  const events: string[] = []
  const tree = (separate: boolean) => <AlternateScreen><Box hoverIgnoresBlankCells
    onMouseEnter={() => events.push('enter')} onMouseLeave={() => events.push('leave')}>
    {separate ? <><Text>A</Text><Text> </Text><Text>B</Text></> : <Text>A B</Text>}
  </Box></AlternateScreen>
  const app = await render(tree(false), { stdout, stdin, patchConsole: false, exitOnCtrlC: false })
  try {
    const ink = instances.get(stdout)!
    ink.dispatchHover(7, 0)
    expect(events).toEqual([])
    ink.dispatchHover(1, 0)
    expect(events).toEqual(['enter'])
    ink.dispatchHover(7, 0)
    expect(events).toEqual(['enter', 'leave'])
    app.rerender(tree(true))
    ink.dispatchHover(1, 0)
    expect(events).toEqual(['enter', 'leave'])
    ink.dispatchHover(0, 0)
    expect(events).toEqual(['enter', 'leave', 'enter'])
  } finally {
    app.unmount()
    app.cleanup()
  }
})

test('a held blank-ignoring hover keeps its click nonempty when its own paint removes the glyph', async () => {
  const { stdout, stdin } = streams()
  let empty: boolean | undefined
  function Target() {
    const [label, setLabel] = React.useState('A')
    return <Box hoverIgnoresBlankCells onMouseEnter={() => setLabel(' ')}
      onClick={event => { empty = event.cellIsBlank }}><Text>{label}</Text></Box>
  }
  const tree = <AlternateScreen><Target/></AlternateScreen>
  const app = await render(tree, { stdout, stdin, patchConsole: false, exitOnCtrlC: false })
  try {
    const ink = instances.get(stdout)!
    ink.dispatchHover(0, 0)
    app.rerender(tree)
    expect(ink.dispatchMouseClick(0, 0)).toBe('handled')
    expect(empty).toBe(false)
    expect(ink.dispatchMouseClick(7, 0)).toBe('handled')
    expect(empty).toBe(true)
  } finally {
    app.unmount()
    app.cleanup()
  }
})

test('Text forwards paint-following hover handlers to the actual rendered text node', async () => {
  const { stdout, stdin } = streams()
  const events: string[] = []
  const tree = (left: number) => <AlternateScreen><Box marginLeft={left}><Text hoverFollowsPaint
    onMouseEnter={() => events.push('enter')} onMouseLeave={() => events.push('leave')}>text target</Text></Box></AlternateScreen>
  const app = await render(tree(0), { stdout, stdin, patchConsole: false, exitOnCtrlC: false })
  try {
    instances.get(stdout)!.dispatchHover(1, 0)
    expect(events).toEqual(['enter'])
    app.rerender(tree(12))
    expect(events).toEqual(['enter', 'leave'])
  } finally {
    app.unmount()
    app.cleanup()
  }
})

test('four consecutive hover layout changes hold paint following for 1000ms; pointer motion resets the hold', async () => {
  let now = 100
  const clock = spyOn(performance, 'now').mockImplementation(() => now)
  const { stdout, stdin } = streams()
  const events: string[] = []
  function MovingTarget({ marker }: { marker: string }) {
    const [left, setLeft] = React.useState(0)
    return <Box marginLeft={left} hoverFollowsPaint
      onMouseEnter={() => { events.push('enter'); setLeft(12) }}
      onMouseLeave={() => { events.push('leave'); setLeft(0) }}><Text>{marker}</Text></Box>
  }
  const tree = (marker: string) => <AlternateScreen><MovingTarget marker={marker}/></AlternateScreen>
  const app = await render(tree('start'), { stdout, stdin, patchConsole: false, exitOnCtrlC: false })
  try {
    const ink = instances.get(stdout)!
    ink.dispatchHover(1, 0)
    app.rerender(tree('start'))
    await until(() => events.length >= 5)
    expect(events).toEqual(['enter', 'leave', 'enter', 'leave', 'enter'])
    now = 1099
    app.rerender(tree('before deadline'))
    expect(events.length).toBe(5)
    now = 1100
    app.rerender(tree('at deadline'))
    await until(() => events.length >= 9)
    expect(events.length).toBe(9)
    ink.dispatchHover(1, 0)
    app.rerender(tree('motion resets hold'))
    await until(() => events.length > 9)
  } finally {
    app.unmount()
    app.cleanup()
    clock.mockRestore()
  }
})

test('a click at new coordinates forgets the old hover position, and exiting alternate screen forgets it too', async () => {
  const { stdout, stdin } = streams()
  let hovered = false
  function InputOwner() { useInput(() => {}); return null }
  const tree = (left: number) => <AlternateScreen><InputOwner/><Button marginLeft={left} onAction={() => {}}>{state => {
    hovered = state.hovered
    return <Text>{state.hovered ? 'HOVER' : 'IDLE'}</Text>
  }}</Button></AlternateScreen>
  const app = await render(tree(0), { stdout, stdin, patchConsole: false, exitOnCtrlC: false })
  try {
    const ink = instances.get(stdout)!
    // Actual App parser consumes both motion and press from the component input stream.
    await until(() => stdin.listenerCount('readable') > 0)
    stdin.push('\x1b[<35;2;1M')
    await until(() => hovered)
    stdin.push('\x1b[<0;14;1M')
    await new Promise<void>(resolve => setImmediate(resolve))
    app.rerender(tree(12))
    expect(hovered).toBe(true)
    app.rerender(<Text>main</Text>)
    app.rerender(tree(0))
    expect(hovered).toBe(false)
    ink.dispatchHover(1, 0)
    app.rerender(tree(0))
    expect(hovered).toBe(true)
  } finally {
    app.unmount()
    app.cleanup()
  }
})
