import { expect, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { appendChildNode, createNode, insertBeforeNode, removeChildNode, setStyle, type DOMElement } from './dom.js'
import { hitTest } from './hit-test.js'
import { nodeCache } from './node-cache.js'
import instances from './instances.js'
import render from './root.js'
import Box from './components/Box.js'
import Button from './components/Button.js'
import Text from './components/Text.js'
import { AlternateScreen } from './components/AlternateScreen.js'

function fixture(col = 6, row = 0) {
  const root = createNode('ink-root'), parent = createNode('ink-box'), target = createNode('ink-box')
  appendChildNode(root, parent)
  appendChildNode(parent, target)
  setStyle(target, { position: 'absolute' })
  nodeCache.set(root, { x: 0, y: 0, width: 40, height: 10 })
  nodeCache.set(parent, { x: 0, y: 0, width: 2, height: 2 })
  nodeCache.set(target, { x: col - 1, y: row, width: 3, height: 1 })
  return { root, parent, target, col, row }
}

for (const [axis, col, row, hit] of [
  ['visible', 6, 0, true], ['hidden', 6, 0, false], ['scroll', 6, 0, false],
  ['overflowX:hidden', 6, 0, false], ['overflowY:hidden', 6, 0, true],
  ['overflowX:hidden', 1, 5, true], ['overflowY:scroll', 1, 5, false],
] as const) {
  test('absolute overflow ' + axis + ' at ' + col + ',' + row, () => {
    const f = fixture(col, row)
    if (axis === 'hidden' || axis === 'scroll') setStyle(f.parent, { overflow: axis })
    if (axis === 'overflowX:hidden') setStyle(f.parent, { overflowX: 'hidden' })
    if (axis === 'overflowY:hidden') setStyle(f.parent, { overflowY: 'hidden' })
    if (axis === 'overflowY:scroll') setStyle(f.parent, { overflowY: 'scroll' })
    expect(hitTest(f.root, col, row)).toBe(hit ? f.target : f.root)
  })
}

test('an escaping absolute descendant wins over a later in-flow sibling', () => {
  const f = fixture(), later = createNode('ink-box')
  appendChildNode(f.root, later)
  nodeCache.set(later, { x: 5, y: 0, width: 3, height: 1 })
  expect(hitTest(f.root, f.col, f.row)).toBe(f.target)
})

test('absolute subtree append, insertion, reparent and late position changes retain visible hit testing', () => {
  const f = fixture(), other = createNode('ink-box')
  appendChildNode(f.root, other)
  nodeCache.set(other, { x: 0, y: 0, width: 2, height: 2 })
  appendChildNode(other, f.target)
  // Reparenting invalidates painted geometry; represent the next completed layout.
  nodeCache.set(f.target, { x: f.col - 1, y: f.row, width: 3, height: 1 })
  expect(hitTest(f.root, f.col, f.row)).toBe(f.target)
  removeChildNode(other, f.target)
  insertBeforeNode(f.parent, f.target, createNode('ink-box'))
  nodeCache.set(f.target, { x: f.col - 1, y: f.row, width: 3, height: 1 })
  expect(hitTest(f.root, f.col, f.row)).toBe(f.target)
  const late = createNode('ink-box'), lateParent = createNode('ink-box')
  appendChildNode(f.root, lateParent)
  appendChildNode(lateParent, late)
  nodeCache.set(lateParent, { x: 0, y: 0, width: 2, height: 2 })
  nodeCache.set(late, { x: 10, y: 0, width: 3, height: 1 })
  expect(hitTest(f.root, 11, 0)).toBe(f.root)
  setStyle(late, { position: 'absolute' })
  expect(hitTest(f.root, 11, 0)).toBe(late)
})

test('a real absolute Button outside its parent follows stationary hover after paint', async () => {
  const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }),
    { columns: 80, rows: 24, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }),
    { isTTY: true, setRawMode() { return this }, ref() { return this }, unref() { return this } }) as unknown as NodeJS.ReadStream
  let hovered = false, element: DOMElement | null = null, parent: DOMElement | null = null
  const tree = (left: number) => <AlternateScreen><Box ref={value => { parent = value }} width={2} height={1}>
    <Button ref={value => { element = value }} position="absolute" left={left} onAction={() => {}}>
      {state => { hovered = state.hovered; return <Text>target</Text> }}
    </Button>
  </Box></AlternateScreen>
  const app = await render(tree(6), { stdout, stdin, patchConsole: false, exitOnCtrlC: false })
  try {
    expect(nodeCache.get(element!)!.x).toBeGreaterThanOrEqual(nodeCache.get(parent!)!.x + 2)
    instances.get(stdout)!.dispatchHover(7, 0)
    app.rerender(tree(6))
    expect(hovered).toBe(true)
    app.rerender(tree(20))
    const deadline = Date.now() + 500
    while (hovered && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve))
    expect(hovered).toBe(false)
    app.rerender(tree(6))
    const returnDeadline = Date.now() + 500
    while (!hovered && Date.now() < returnDeadline) await new Promise<void>(resolve => setImmediate(resolve))
    expect(hovered).toBe(true)
  } finally {
    app.unmount()
    app.cleanup()
  }
})
