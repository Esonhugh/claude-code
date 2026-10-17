import { expect, mock, test } from 'bun:test'
import chalk from 'chalk'
import sliceAnsi from '../utils/sliceAnsi.js'
import { CharPool, HyperlinkPool, StylePool, cellAt, createScreen } from './screen.js'

const realSliceAnsi = sliceAnsi
let slices = 0
mock.module('../utils/sliceAnsi.js', () => ({
  default: (...args: Parameters<typeof sliceAnsi>) => {
    slices++
    return realSliceAnsi(...args)
  },
}))
const { default: Output } = await import('./output.js')

function rowText(screen: ReturnType<typeof createScreen>, row: number): string {
  let text = ''
  for (let col = 0; col < screen.width; col++) text += cellAt(screen, col, row)?.char || ' '
  return text.trimEnd()
}

test('a clipped write only slices the visible lines that cross the horizontal clip', () => {
  const stylePool = new StylePool()
  const screen = createScreen(20, 4, stylePool, new CharPool(), new HyperlinkPool())
  const output = new Output({ width: 20, height: 4, stylePool, screen })
  output.clip({ x1: 2, x2: 12, y1: 1, y2: 3 })
  // Scrolled content: rows above and below the clip, two visible rows that fit and one that overflows.
  output.write(2, 0, [
    chalk.red('hidden above'),
    chalk.green('fits'),
    `${chalk.blue('too long')} for the clip`,
    'hidden below',
  ].join('\n'))
  output.unclip()
  slices = 0
  output.get()
  expect(slices).toBe(1)
  expect(rowText(screen, 0)).toBe('')
  expect(rowText(screen, 1)).toBe('  fits')
  expect(rowText(screen, 2)).toBe('  too long f')
  expect(rowText(screen, 3)).toBe('')
})
