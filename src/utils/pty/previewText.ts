import stripAnsi from 'strip-ansi'

function stripEmptyLines(content: string): string {
  const lines = content.split('\n')
  let startIndex = 0
  while (startIndex < lines.length && lines[startIndex]?.trim() === '') {
    startIndex++
  }

  let endIndex = lines.length - 1
  while (endIndex >= 0 && lines[endIndex]?.trim() === '') {
    endIndex--
  }

  if (startIndex > endIndex) {
    return ''
  }
  return lines.slice(startIndex, endIndex + 1).join('\n')
}

/**
 * Normalize terminal text for read-only preview display.
 * - strip ANSI sequences
 * - normalize CRLF line endings
 * - collapse carriage-return redraws to the latest visible line content
 * - trim empty leading/trailing lines
 */
export function normalizeTerminalPreview(text: string): string {
  if (!text) {
    return ''
  }

  const noAnsi = stripAnsi(text)
  const lines = noAnsi.replace(/\r\n/g, '\n').split('\n')
  const normalized = lines.map(line => {
    const parts = line.split('\r')
    return parts[parts.length - 1] ?? ''
  })
  return stripEmptyLines(normalized.join('\n'))
}
