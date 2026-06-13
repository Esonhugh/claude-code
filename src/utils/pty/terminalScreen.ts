export type TerminalScreenCell = {
  char: string
  style: TerminalScreenStyle
}

export type TerminalScreenStyle = {
  fg?: number
}

export type TerminalScreen = {
  cols: number
  rows: number
  cursorRow: number
  cursorCol: number
  pendingWrap: boolean
  lines: TerminalScreenCell[][]
}

function createBlankLine(cols: number): TerminalScreenCell[] {
  return Array.from({ length: cols }, () => ({ char: ' ', style: {} }))
}

export function createTerminalScreen(cols: number, rows: number): TerminalScreen {
  return {
    cols,
    rows,
    cursorRow: 0,
    cursorCol: 0,
    pendingWrap: false,
    lines: Array.from({ length: rows }, () => createBlankLine(cols)),
  }
}

function createBlankCell(style: TerminalScreenStyle = {}): TerminalScreenCell {
  return { char: ' ', style: { ...style } }
}

export function moveCursorToColumn(screen: TerminalScreen, col: number): void {
  screen.pendingWrap = false
  screen.cursorCol = Math.max(0, Math.min(col, screen.cols - 1))
}

export function moveCursorToNextRow(screen: TerminalScreen): void {
  screen.pendingWrap = false
  screen.cursorCol = 0
  if (screen.cursorRow < screen.rows - 1) {
    screen.cursorRow += 1
    return
  }

  screen.lines.shift()
  screen.lines.push(Array.from({ length: screen.cols }, () => createBlankCell()))
}

export function writeCharToScreen(
  screen: TerminalScreen,
  char: string,
  style: TerminalScreenStyle = {},
): void {
  if (screen.pendingWrap) {
    moveCursorToNextRow(screen)
  }

  const row = screen.lines[screen.cursorRow]
  if (!row) {
    return
  }

  row[screen.cursorCol] = { char, style: { ...style } }
  if (screen.cursorCol < screen.cols - 1) {
    screen.cursorCol += 1
    return
  }

  screen.pendingWrap = true
}

export function lineText(screen: TerminalScreen, row: number): string {
  return (screen.lines[row] ?? []).map(cell => cell.char).join('')
}
