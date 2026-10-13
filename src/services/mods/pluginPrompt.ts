import { stringWidth } from '../../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../../utils/intl.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import { truncateToWidth } from '../../utils/truncate.js'
import type { PromptOrigin } from './promptAdapter.js'

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
  // Names are clipped to 256 UTF-16 units before tabs expand (at most 2048).
  // The official long-line and work-budget clipping paths cannot be reached.
  return clean.split('\n').map(line => {
    const suffix = line.match(/… \[\+\d+ graphemes\]$/)?.[0] ?? ''
    return repairLine(line.slice(0, line.length - suffix.length)) + suffix
  }).join('\n')
}

function displayName(name: string): string {
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

export function formatPluginPrompt(
  text: string,
  origin: Extract<PromptOrigin, {kind:'plugin'}>,
  midTurn = false,
): string {
  if (origin.asUser === true) return midTurn
    ? `The user sent a new message while you were working:\n${text}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.`
    : text
  const name = displayName(origin.name)
  return midTurn
    ? `The ${name} plugin sent a message while you were working:\n${text}\n\nThis is how Claude Code surfaces prompts a plugin submits mid-turn — within the running turn, often alongside the next tool result. Address the message above as you continue this turn.`
    : `The ${name} plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`
}
