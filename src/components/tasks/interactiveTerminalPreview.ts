export function interactiveTerminalPreviewLines(
  preview: string,
  rows: number,
  maxVisibleRows: number,
): string[] {
  const normalized = preview || 'No output yet'
  const lines = normalized.split('\n')
  const visibleRows = Math.max(1, Math.min(rows, maxVisibleRows))
  return lines.slice(-visibleRows)
}

export function interactiveTerminalPreviewSummary(preview: string): string | undefined {
  const lines = preview
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return lines.at(-1)
}

export function interactiveTerminalPreviewHeight(rows: number): number {
  return Math.max(rows + 2, 3)
}
