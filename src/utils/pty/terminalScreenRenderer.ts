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
