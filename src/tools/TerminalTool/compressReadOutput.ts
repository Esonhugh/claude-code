export type CompactReadOutputOptions = {
  maxBytes: number
  maxLines: number
  maxLineChars: number
}

export type CompactReadOutputResult = {
  text: string
  compressed: boolean
  originalBytes: number
  returnedBytes: number
  omittedLines: number
  omittedChars: number
}

export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
    return text
  }

  let end = maxBytes
  while (end > 0) {
    const decoded = buffer.subarray(0, end).toString('utf8')
    if (!decoded.includes('�')) {
      return decoded
    }
    end -= 1
  }
  return ''
}

function elideLine(
  line: string,
  maxLineChars: number,
): { line: string; omittedChars: number } {
  if (line.length <= maxLineChars) {
    return { line, omittedChars: 0 }
  }

  const markerFor = (count: number) => `[... ${count} chars omitted ...]`
  const minimumContextChars = 8
  let prefixLength = Math.ceil(maxLineChars * 0.6)
  let suffixLength = Math.max(1, maxLineChars - prefixLength)
  let omittedChars = Math.max(0, line.length - prefixLength - suffixLength)
  let marker = markerFor(omittedChars)

  while (
    prefixLength + marker.length + suffixLength > maxLineChars &&
    prefixLength + suffixLength > minimumContextChars
  ) {
    if (prefixLength > suffixLength + 1) {
      prefixLength -= 1
    } else {
      suffixLength -= 1
    }
    omittedChars = Math.max(0, line.length - prefixLength - suffixLength)
    marker = markerFor(omittedChars)
  }

  return {
    line: `${line.slice(0, prefixLength)}${marker}${line.slice(
      line.length - suffixLength,
    )}`,
    omittedChars,
  }
}

function collapseRuns(lines: string[]): {
  lines: string[]
  omittedLines: number
} {
  const output: string[] = []
  let omittedLines = 0
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (line === '') {
      let end = index + 1
      while (end < lines.length && lines[end] === '') end += 1
      const count = end - index
      if (count >= 3) {
        output.push(`[... ${count} blank lines omitted ...]`)
        omittedLines += count
      } else {
        output.push(...lines.slice(index, end))
      }
      index = end
      continue
    }

    let end = index + 1
    while (end < lines.length && lines[end] === line) end += 1
    const count = end - index
    output.push(line)
    if (count >= 3) {
      output.push(`[... repeated ${count - 1} more times ...]`)
      omittedLines += count - 1
    } else if (count === 2) {
      output.push(line)
    }
    index = end
  }

  return { lines: output, omittedLines }
}

function limitLines(lines: string[], maxLines: number): {
  lines: string[]
  omittedLines: number
} {
  if (lines.length <= maxLines) {
    return { lines, omittedLines: 0 }
  }

  const topCount = Math.min(10, Math.max(1, maxLines - 2))
  const bottomCount = Math.max(1, maxLines - topCount - 1)
  const omittedLines = lines.length - topCount - bottomCount

  return {
    lines: [
      ...lines.slice(0, topCount),
      `[... ${omittedLines} lines omitted ...]`,
      ...lines.slice(lines.length - bottomCount),
    ],
    omittedLines,
  }
}

export function compactReadOutput(
  text: string,
  options: CompactReadOutputOptions,
): CompactReadOutputResult {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const collapsed = collapseRuns(text.split('\n'))

  let omittedChars = 0
  const lineElided = collapsed.lines.map(line => {
    const result = elideLine(line, options.maxLineChars)
    omittedChars += result.omittedChars
    return result.line
  })

  const lineLimited = limitLines(lineElided, options.maxLines)
  const compactText = lineLimited.lines.join('\n')
  const truncated = truncateUtf8Bytes(compactText, options.maxBytes)
  const returnedBytes = Buffer.byteLength(truncated, 'utf8')

  return {
    text: truncated,
    compressed:
      collapsed.omittedLines > 0 ||
      omittedChars > 0 ||
      lineLimited.omittedLines > 0 ||
      returnedBytes < Buffer.byteLength(compactText, 'utf8'),
    originalBytes,
    returnedBytes,
    omittedLines: collapsed.omittedLines + lineLimited.omittedLines,
    omittedChars,
  }
}
