import { expect, test } from 'bun:test'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from './screen.js'
import type { Frame } from './frame.js'
import {
  applyTerminalOutput,
  createTerminalScreenRenderer,
  renderedPreview,
} from '../utils/pty/terminalScreenRenderer.js'
import { LogUpdate } from './log-update.js'
import { writeDiffToTerminal } from './terminal.js'

function frame(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  lines: readonly string[],
  stylePool: StylePool,
  charPool: CharPool,
  hyperlinkPool: HyperlinkPool,
): Frame {
  const screen = createScreen(
    width,
    height,
    stylePool,
    charPool,
    hyperlinkPool,
  )
  for (let y = 0; y < lines.length; y++) {
    for (let x = 0; x < lines[y]!.length; x++) {
      setCellAt(screen, x, y, {
        char: lines[y]![x]!,
        styleId: stylePool.none,
        width: CellWidth.Narrow,
        hyperlink: undefined,
      })
    }
  }
  return {
    screen,
    viewport: { width: viewportWidth, height: viewportHeight },
    cursor: { x: 0, y: height, visible: false },
  }
}

function resetFrames(stylePool: StylePool): [Frame, Frame] {
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  return [
    frame(
      4,
      2,
      4,
      2,
      ['old', 'row'],
      stylePool,
      charPool,
      hyperlinkPool,
    ),
    frame(
      5,
      2,
      5,
      2,
      ['next', 'last'],
      stylePool,
      charPool,
      hyperlinkPool,
    ),
  ]
}

test('alt-screen full reset positions rows absolutely without bottom-margin newlines', () => {
  const stylePool = new StylePool()
  const [prev, next] = resetFrames(stylePool)
  const diff = new LogUpdate({ isTTY: true, stylePool }).render(
    prev,
    next,
    true,
  )
  const output = diff
    .filter(patch => patch.type === 'stdout')
    .map(patch => patch.content)
    .join('')

  expect(diff[0]).toMatchObject({ type: 'clearTerminal', reason: 'resize' })
  expect(output).toContain('\u001b[1;1Hnext')
  expect(output).toContain('\u001b[2;1Hlast')
  expect(output).not.toContain('\n')

  const terminal = createTerminalScreenRenderer(5, 2)
  writeDiffToTerminal(
    {
      stdout: {
        write(chunk: string | Uint8Array) {
          applyTerminalOutput(terminal, chunk.toString())
          return true
        },
      } as NodeJS.WriteStream,
      stderr: process.stderr,
    },
    diff,
    true,
  )
  expect(renderedPreview(terminal)).toBe('next\nlast')
})

test('alt-screen offscreen reset keeps the top and bottom rows stable', () => {
  const stylePool = new StylePool()
  const charPool = new CharPool()
  const hyperlinkPool = new HyperlinkPool()
  const prev = frame(
    5,
    3,
    5,
    2,
    ['old-a', 'old-b', 'old-c'],
    stylePool,
    charPool,
    hyperlinkPool,
  )
  const next = frame(
    5,
    2,
    5,
    2,
    ['new-a', 'new-b'],
    stylePool,
    charPool,
    hyperlinkPool,
  )
  const diff = new LogUpdate({ isTTY: true, stylePool }).render(
    prev,
    next,
    true,
  )

  expect(diff[0]).toMatchObject({ type: 'clearTerminal', reason: 'offscreen' })
  const terminal = createTerminalScreenRenderer(5, 2)
  applyTerminalOutput(terminal, '\u001b[?1049h\u001b[2J\u001b[H')
  writeDiffToTerminal(
    {
      stdout: {
        write(chunk: string | Uint8Array) {
          applyTerminalOutput(terminal, chunk.toString())
          return true
        },
      } as NodeJS.WriteStream,
      stderr: process.stderr,
    },
    diff,
    true,
  )
  expect(renderedPreview(terminal)).toBe('new-a\nnew-b')
})

test('main-screen full reset continues advancing rows with newlines', () => {
  const stylePool = new StylePool()
  const [prev, next] = resetFrames(stylePool)
  const diff = new LogUpdate({ isTTY: true, stylePool }).render(
    prev,
    next,
    false,
  )
  const output = diff
    .filter(patch => patch.type === 'stdout')
    .map(patch => patch.content)
    .join('')

  expect(diff[0]).toMatchObject({ type: 'clearTerminal', reason: 'resize' })
  expect(output).toContain('\n')
  expect(output).not.toContain('\u001b[1;1H')
  expect(output).not.toContain('\u001b[2;1H')
})
