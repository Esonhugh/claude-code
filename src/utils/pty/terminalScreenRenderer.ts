import {
  createTerminalScreen,
  moveCursorToColumn,
  moveCursorToNextRow,
  type TerminalScreen,
  type TerminalScreenStyle,
  writeCharToScreen,
} from './terminalScreen.js'
import { screenToPreview } from './terminalScreenToPreview.js'

type StyleState = TerminalScreenStyle

export type TerminalScreenRenderer = {
  cols: number
  rows: number
  screen: TerminalScreen
  currentStyle: StyleState
  pendingEscapeBuffer: string
}

function applySgr(renderer: TerminalScreenRenderer, sgr: string): void {
  const codes = sgr
    .split(';')
    .map(part => Number.parseInt(part || '0', 10))
    .filter(code => !Number.isNaN(code))

  if (codes.length === 0 || codes.includes(0)) {
    renderer.currentStyle = {}
  }

  for (const code of codes) {
    if (code >= 30 && code <= 37) {
      renderer.currentStyle.fg = code
    }
  }
}

function writeStyledChar(renderer: TerminalScreenRenderer, char: string): void {
  writeCharToScreen(renderer.screen, char, renderer.currentStyle)
}

function consumeCsiSequence(renderer: TerminalScreenRenderer, input: string): number {
  let index = 2
  while (index < input.length) {
    const char = input[index]!
    const isFinalByte =
      (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z')
    if (isFinalByte) {
      const params = input.slice(2, index)
      const command = char

      if (command === 'm') {
        applySgr(renderer, params)
      }

      renderer.pendingEscapeBuffer = ''
      return index + 1
    }
    index += 1
  }

  renderer.pendingEscapeBuffer = input
  return input.length
}

function consumeOscSequence(renderer: TerminalScreenRenderer, input: string): number {
  let index = 2
  while (index < input.length) {
    const char = input[index]!
    if (char === '') {
      renderer.pendingEscapeBuffer = ''
      return index + 1
    }
    if (char === '' && input[index + 1] === '\\') {
      renderer.pendingEscapeBuffer = ''
      return index + 2
    }
    index += 1
  }

  renderer.pendingEscapeBuffer = input
  return input.length
}

function consumeAnsiSequence(renderer: TerminalScreenRenderer, input: string): number {
  if (input[0] !== '') {
    return 0
  }

  if (input[1] === '[') {
    return consumeCsiSequence(renderer, input)
  }

  if (input[1] === ']') {
    return consumeOscSequence(renderer, input)
  }

  return 1
}

export function createTerminalScreenRenderer(
  cols: number,
  rows: number,
): TerminalScreenRenderer {
  return {
    cols,
    rows,
    screen: createTerminalScreen(cols, rows),
    currentStyle: {},
    pendingEscapeBuffer: '',
  }
}

export function applyTerminalOutput(
  renderer: TerminalScreenRenderer,
  text: string,
): void {
  let input = renderer.pendingEscapeBuffer + text
  renderer.pendingEscapeBuffer = ''

  while (input.length > 0) {
    if (input[0] === '') {
      const consumed = consumeAnsiSequence(renderer, input)
      if (consumed === input.length && renderer.pendingEscapeBuffer) {
        return
      }
      input = input.slice(consumed)
      continue
    }

    const char = input[0]!
    input = input.slice(1)

    if (char === '\r') {
      moveCursorToColumn(renderer.screen, 0)
      continue
    }

    if (char === '\n') {
      moveCursorToNextRow(renderer.screen)
      continue
    }

    writeStyledChar(renderer, char)
  }
}

export function resizeTerminalScreenRenderer(
  renderer: TerminalScreenRenderer,
  cols: number,
  rows: number,
): void {
  renderer.cols = cols
  renderer.rows = rows
  renderer.screen.cols = cols
  renderer.screen.rows = rows
}

export function renderedPreview(renderer: TerminalScreenRenderer): string {
  return screenToPreview(renderer.screen)
}
