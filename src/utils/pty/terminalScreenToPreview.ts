import type { TerminalScreen, TerminalScreenCell } from './terminalScreen.js'

function sameStyle(a: TerminalScreenCell['style'], b: TerminalScreenCell['style']): boolean {
  return a.fg === b.fg
}

function stylePrefix(style: TerminalScreenCell['style']): string {
  return style.fg ? `[${style.fg}m` : ''
}

function styleSuffix(style: TerminalScreenCell['style']): string {
  return style.fg ? '[0m' : ''
}

function renderLine(line: TerminalScreenCell[]): string {
  let result = ''
  let run = ''
  let currentStyle = line[0]?.style ?? {}

  for (const cell of line) {
    if (!sameStyle(currentStyle, cell.style)) {
      result += `${stylePrefix(currentStyle)}${run}${styleSuffix(currentStyle)}`
      run = ''
      currentStyle = cell.style
    }
    run += cell.char
  }

  result += `${stylePrefix(currentStyle)}${run}${styleSuffix(currentStyle)}`
  return result.trimEnd()
}

export function screenToPreview(screen: TerminalScreen): string {
  return screen.lines.map(renderLine).join('\n').trim()
}
