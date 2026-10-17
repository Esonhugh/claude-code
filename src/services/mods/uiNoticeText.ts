import { stringWidth } from '../../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import { truncateToWidth } from '../../utils/truncate.js'

const ignored = /\p{Default_Ignorable_Code_Point}|\p{Cf}/u
const combining = /\p{M}/u
const replacement = '\uFFFD'

function isBidi(code: number): boolean {
  return code === 1564 || (code >= 8234 && code <= 8238) || (code >= 8294 && code <= 8297)
}

function hasWidth(text: string): boolean {
  return stringWidth(text.replace(/[\uFE0E\uFE0F\u180B-\u180F\u2800]/gu, '').trim()) > 0
}

function repairLine(text: string): string {
  function pass(value: string): { consistent: boolean; repaired: string } {
    let prefix = '', width = 0, repaired = '', consistent = true
    for (const { segment } of getGraphemeSegmenter().segment(value)) {
      prefix += segment
      const nextWidth = stringWidth(prefix)
      const code = segment.codePointAt(0)!
      const expected = segment.length === 1 && code <= 31 ? 0
        : segment.length === 1 && isBidi(code) ? 1 : stringWidth(segment)
      const matches = nextWidth - width === expected
      consistent &&= matches
      repaired += matches ? segment : replacement
      width = nextWidth
    }
    return { consistent, repaired }
  }
  for (let attempt = 0; attempt < 16; attempt++) {
    const result = pass(text)
    if (result.consistent) return text
    if (result.repaired === text) break
    text = result.repaired
  }
  if (pass(text).consistent) return text
  return Array.from(getGraphemeSegmenter().segment(text), () => replacement).join('')
}

function cleanControls(text: string): string {
  let clean = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code === 65038 || code === 65039) continue
    clean += (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
      || isBidi(code) || (code >= 55296 && code <= 57343) ? replacement : char
  }
  if (clean.includes('\t')) {
    let expanded = '', column = 0
    for (const part of clean.split(/(\t|\n)/)) {
      if (part === '\t') {
        const spaces = 8 - column % 8
        expanded += ' '.repeat(spaces)
        column += spaces
      } else if (part === '\n') {
        expanded += part
        column = 0
      } else {
        expanded += part
        column += stringWidth(part)
      }
    }
    clean = expanded
  }
  // Both notice text and names are bounded before sanitizing (at most 2048 units).
  // The official long-line and work-budget clipping paths cannot be reached.
  return clean.split('\n').map(line => {
    const suffix = line.match(/… \[\+\d+ graphemes\]$/)?.[0] ?? ''
    return repairLine(line.slice(0, line.length - suffix.length)) + suffix
  }).join('\n')
}

export function formatPluginDisplayName(name: string): string {
  if (typeof name !== 'string') return 'unnamed'
  let clipped = name.slice(0, 256)
  const last = clipped.charCodeAt(clipped.length - 1)
  if (name.length > 256 && last >= 55296 && last <= 56319) clipped = clipped.slice(0, -1)
  const chars = Array.from(clipped)
  let clean = chars.map((char, index) => {
    const code = char.codePointAt(0)!
    const before = chars[index - 1]?.codePointAt(0) ?? NaN
    const after = chars[index + 1]?.codePointAt(0) ?? NaN
    const replace = code === 65038 || code === 65039 ? !(before > 127 || after === 8419)
      : code === 8204 || code === 8205 ? !(before > 127 && after > 127)
      : code >= 6155 && code <= 6159 ? !(before > 127)
      : ignored.test(char) || code === 8232 || code === 8233 || code === 10240
        || (code >= 55296 && code <= 57343) || code === 1109742
    return replace ? replacement : char
  }).join('')
  clean = cleanControls(clean)
  let bounded = '', run = 0, overflow = false
  for (const char of clean) {
    const invisible = stringWidth(char.replace(/[\uFE0E\uFE0F\u180B-\u180F]/gu, '')) <= 0
    if (char === '\n' || (!combining.test(char) && !invisible)) {
      if (overflow) bounded += replacement
      overflow = false
      bounded += char
      run = 0
    } else if (run < 8) {
      bounded += char
      run++
    } else overflow = true
  }
  if (overflow) bounded += replacement
  clean = cleanControls(bounded).replace(/\t/g, ' ')
  const first = firstLineOf(clean)
  let visible = '', skipped = false
  for (const char of first) {
    if (char !== '\n' && !hasWidth(char)) { skipped = true; continue }
    if (char === replacement && skipped) { skipped = false; continue }
    skipped = false
    visible += char
  }
  if (!hasWidth(visible)) return 'unnamed'
  if (Array.from(first).filter(hasWidth).at(-1) === '…') return 'unnamed'
  if (clean.includes('\n')) return stringWidth(first) + 1 > 24
    ? truncateToWidth(first + '…', 24) : first + '…'
  return truncateToWidth(first, 24)
}


function boundInvisibleRuns(text: string): string {
  let result = '', run = 0, overflow = false
  for (const char of text) {
    const invisible = stringWidth(char.replace(/[\uFE0E\uFE0F\u180B-\u180F]/gu, '')) <= 0
    if (char === '\n' || (!combining.test(char) && !invisible)) {
      if (overflow) result += replacement
      result += char
      run = 0
      overflow = false
    } else if (run < 8) { result += char; run++ }
    else overflow = true
  }
  return overflow ? result + replacement : result
}

/** Official 2.1.292: bounded, sanitized single row prefixed with the plugin display name. */
export function formatPluginNotice(plugin: string, text: string): string {
  let clipped = text.slice(0, 2000)
  const last = clipped.charCodeAt(clipped.length - 1)
  if (text.length > 2000 && last >= 55296 && last <= 56319) clipped = clipped.slice(0, -1)
  clipped = clipped.replace(/\t/g, ' ') + (text.length > 2000 ? '…' : '')
  let clean = ''
  for (const char of clipped) {
    const code = char.codePointAt(0)!
    const allowed = (code >= 8204 && code <= 8207) || code === 1564 || (code >= 65024 && code <= 65039)
      || (code >= 6155 && code <= 6159) || code === 10240
    const unsafe = ignored.test(char) || code === 8232 || code === 8233 || code === 10240
      || (code >= 55296 && code <= 57343) || code === 1109742
    clean += unsafe && !allowed ? replacement : char
  }
  const line = cleanControls(boundInvisibleRuns(cleanControls(clean))).replace(/[\n\r\u2028\u2029]/g, replacement)
  return `${formatPluginDisplayName(plugin)}: ${line}`
}
