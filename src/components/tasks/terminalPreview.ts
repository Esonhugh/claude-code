import stripAnsi from 'strip-ansi'

export function terminalPreviewLines(
  preview: string,
  rows: number,
  maxVisibleRows: number,
): string[] {
  const normalized = preview || 'No output yet'
  const lines = normalized.split('\n')
  while (lines.length > 1 && stripAnsi(lines.at(-1)!).trim() === '') {
    lines.pop()
  }
  const visibleRows = Math.max(1, Math.min(rows, maxVisibleRows))
  return lines.slice(-visibleRows)
}

export function terminalPreviewSummary(preview: string): string | undefined {
  const lines = preview
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return lines.at(-1)
}

export function terminalPreviewHeight(rows: number): number {
  return Math.max(rows + 2, 3)
}

// Divider, title, header lines, preview border and input guide around the preview box.
const DETAIL_DIALOG_CHROME_ROWS = 14

export function terminalPreviewVisibleRows(
  ptyRows: number,
  terminalRows: number,
  fullscreen: boolean,
): number {
  // Fullscreen caps the bottom area (where the dialog renders) at half the terminal.
  const available = fullscreen ? Math.floor(terminalRows / 2) : terminalRows
  return Math.max(3, Math.min(ptyRows, available - DETAIL_DIALOG_CHROME_ROWS))
}
