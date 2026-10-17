import { afterEach, beforeEach, expect, test } from 'bun:test'
import chalk from 'chalk'
import { ColorDiff } from '../native-ts/color-diff/index.js'
import {
  appendChildNode,
  createNode,
  setStyle,
  type DOMElement,
} from './dom.js'
import Output from './output.js'
import renderNodeToOutput from './render-node-to-output.js'
import {
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
  type Screen,
} from './screen.js'
import applyStyles, { type Color } from './styles.js'

let previousLevel: typeof chalk.level
let previousColorTerm: string | undefined
beforeEach(() => {
  previousLevel = chalk.level
  previousColorTerm = process.env.COLORTERM
  chalk.level = 2
  delete process.env.COLORTERM
})
afterEach(() => {
  chalk.level = previousLevel
  if (previousColorTerm === undefined) delete process.env.COLORTERM
  else process.env.COLORTERM = previousColorTerm
})

function scene(lines: string[], backgroundColor?: Color) {
  const root = createNode('ink-box')
  const raw = createNode('ink-raw-ansi')
  const stylePool = new StylePool()
  const chars = new CharPool()
  const links = new HyperlinkPool()
  raw.attributes = {
    rawText: lines.join('\n'),
    rawWidth: 40,
    rawHeight: lines.length,
  }
  appendChildNode(root, raw)
  const output = new Output({
    width: 42,
    height: lines.length + 2,
    stylePool,
    screen: createScreen(42, lines.length + 2, stylePool, chars, links),
  })
  function paint(color: Color | undefined, prevScreen?: Screen) {
    const style = {
      width: 42,
      height: lines.length + 2,
      borderStyle: 'single' as const,
      backgroundColor: color,
    }
    setStyle(root, style)
    applyStyles(root.yogaNode!, style)
    root.yogaNode!.calculateLayout()
    output.reset(
      42,
      lines.length + 2,
      createScreen(42, lines.length + 2, stylePool, chars, links),
    )
    renderNodeToOutput(root, output, { prevScreen })
    return output.get()
  }
  const screen = paint(backgroundColor)
  return { root, raw, screen, stylePool, paint }
}

function codes(screen: Screen, pool: StylePool, x: number, y: number) {
  return pool.get(cellAt(screen, x, y)!.styleId).map((style) => style.code)
}
function dispose(root: DOMElement) {
  root.yogaNode!.freeRecursive()
}

test('raw rows inherit the box background through full resets, default backgrounds and newlines', () => {
  const value = scene(
    ['\x1b[0m\x1b[38;5;197mexport\x1b[49m plain', 'next\x1b[0m reset'],
    'ansi256(235)',
  )
  try {
    for (const [x, y] of [
      [1, 1],
      [8, 1],
      [1, 2],
      [6, 2],
    ])
      expect(codes(value.screen, value.stylePool, x!, y!)).toContain(
        '\x1b[48;5;235m',
      )
    expect(codes(value.screen, value.stylePool, 1, 1)).toContain(
      '\x1b[38;5;197m',
    )
  } finally {
    dispose(value.root)
  }
})

test('real diff context and gutters inherit while explicit line and word backgrounds survive', () => {
  const lines = new ColorDiff(
    {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      lines: [
        ' export const retained = true;',
        '-export const count = 1;',
        '+export const count = 2;',
      ],
    },
    null,
    'alpha.ts',
    null,
  ).render('dark', 40, false)!
  const value = scene(lines, 'ansi256(235)')
  try {
    expect(codes(value.screen, value.stylePool, 5, 1)).toContain(
      '\x1b[48;5;235m',
    )
    expect(codes(value.screen, value.stylePool, 2, 1)).toContain(
      '\x1b[48;5;235m',
    )
    expect(codes(value.screen, value.stylePool, 5, 2)).not.toContain(
      '\x1b[48;5;235m',
    )
    expect(codes(value.screen, value.stylePool, 5, 3)).toContain(
      '\x1b[48;5;22m',
    )
    expect(codes(value.screen, value.stylePool, 26, 3)).toContain(
      '\x1b[48;5;28m',
    )
  } finally {
    dispose(value.root)
  }
})

test('all four border sides inherit the box background', () => {
  const value = scene(['text'], 'ansi256(235)')
  try {
    for (const [x, y] of [
      [0, 0],
      [10, 0],
      [0, 1],
      [41, 1],
      [10, 2],
    ])
      expect(codes(value.screen, value.stylePool, x!, y!)).toContain(
        '\x1b[48;5;235m',
      )
  } finally {
    dispose(value.root)
  }
})

test('changing background reuses raw text without stale cached cell colours', () => {
  const value = scene(['\x1b[0munchanged'], 'ansi256(235)')
  try {
    const next = value.paint('ansi256(237)', value.screen)
    expect(codes(next, value.stylePool, 1, 1)).toContain('\x1b[48;5;237m')
    expect(codes(next, value.stylePool, 1, 1)).not.toContain('\x1b[48;5;235m')
    const plain = value.paint(undefined, next)
    expect(codes(plain, value.stylePool, 1, 1)).not.toContain('\x1b[48;5;237m')
  } finally {
    dispose(value.root)
  }
})

test('missing backgrounds preserve raw colours and NO_COLOR does not introduce a background', () => {
  for (const level of [0, 2] as const) {
    chalk.level = level
    const value = scene(
      ['\x1b[38;5;197mexport'],
      level === 0 ? 'ansi256(235)' : undefined,
    )
    try {
      expect(codes(value.screen, value.stylePool, 1, 1)).toEqual([
        '\x1b[38;5;197m',
      ])
    } finally {
      dispose(value.root)
    }
  }
})
