import * as xtermHeadless from '@xterm/headless'
import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal as XtermTerminal,
} from '@xterm/headless'

type XtermTerminalConstructor = new (
  options?: ITerminalOptions & ITerminalInitOnlyOptions,
) => XtermTerminal

type XtermHeadlessModule = {
  Terminal?: XtermTerminalConstructor
  default?: { Terminal?: XtermTerminalConstructor }
  'module.exports'?: { Terminal?: XtermTerminalConstructor }
}

const xtermModule = xtermHeadless as XtermHeadlessModule
const Terminal =
  xtermModule.Terminal ??
  xtermModule.default?.Terminal ??
  xtermModule['module.exports']?.Terminal

if (!Terminal) {
  throw new Error('Unable to load @xterm/headless Terminal export')
}

export type TerminalScreenRenderer = {
  terminal: XtermTerminal
}

function writeSync(terminal: XtermTerminal, text: string): void {
  const writeBuffer = (terminal as unknown as {
    _core?: { _writeBuffer?: { writeSync(data: string): void } }
  })._core?._writeBuffer

  if (!writeBuffer) {
    terminal.write(text)
    return
  }

  writeBuffer.writeSync(text)
}

function visibleLines(terminal: XtermTerminal): string[] {
  const buffer = terminal.buffer.active
  const start = buffer.baseY
  const lines: string[] = []

  for (let row = 0; row < terminal.rows; row += 1) {
    lines.push(buffer.getLine(start + row)?.translateToString(true) ?? '')
  }

  return lines
}

export function createTerminalScreenRenderer(
  cols: number,
  rows: number,
): TerminalScreenRenderer {
  return {
    terminal: new Terminal({
      allowProposedApi: true,
      cols,
      convertEol: true,
      logLevel: 'off',
      rows,
      windowsPty: process.platform === 'win32' ? { backend: 'conpty' } : undefined,
    }),
  }
}

export function applyTerminalOutput(
  renderer: TerminalScreenRenderer,
  text: string,
): void {
  writeSync(renderer.terminal, text)
}

export function resizeTerminalScreenRenderer(
  renderer: TerminalScreenRenderer,
  cols: number,
  rows: number,
): void {
  renderer.terminal.resize(cols, rows)
}

export function renderedPreview(renderer: TerminalScreenRenderer): string {
  return visibleLines(renderer.terminal).join('\n').trim()
}

/** A run of same-styled characters; `fg` is an SGR code (30–37, 90–97). */
export type TerminalScreenSpan = { text: string; fg?: number; bold?: true }

export type StructuredTerminalScreen = {
  cols: number
  rows: number
  lines: TerminalScreenSpan[][]
}

/**
 * The visible screen as rows of styled spans, read from the emulator's cell
 * buffer so hosts can color it without parsing ANSI. Only the 16 basic
 * foreground colors are kept; trailing blanks are dropped.
 */
export function renderedScreen(
  renderer: TerminalScreenRenderer,
): StructuredTerminalScreen {
  const { terminal } = renderer
  const buffer = terminal.buffer.active
  const cell = buffer.getNullCell()
  const lines: TerminalScreenSpan[][] = []
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row)
    const spans: TerminalScreenSpan[] = []
    for (let col = 0; line && col < terminal.cols; col += 1) {
      line.getCell(col, cell)
      if (cell.getWidth() === 0) continue
      const palette = cell.isFgPalette() ? cell.getFgColor() : -1
      const fg =
        palette >= 0 && palette < 8
          ? 30 + palette
          : palette >= 8 && palette < 16
            ? 82 + palette
            : undefined
      const bold = cell.isBold() ? true : undefined
      const text = cell.getChars() || ' '
      const last = spans.at(-1)
      if (last && last.fg === fg && last.bold === bold) last.text += text
      else spans.push({ text, ...(fg && { fg }), ...(bold && { bold }) })
    }
    while (spans.length) {
      const last = spans.at(-1)!
      const trimmed = last.text.trimEnd()
      if (trimmed) {
        last.text = trimmed
        break
      }
      spans.pop()
    }
    lines.push(spans)
  }
  return { cols: terminal.cols, rows: terminal.rows, lines }
}
