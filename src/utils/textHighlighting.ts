import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  type Token,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import type { PromptDecoration } from '../services/mods/promptEdit.js'
import type { Theme } from './theme.js'
import type { Props as TextProps } from '../components/design-system/ThemedText.js'

export type TextHighlight = {
  start: number
  end: number
  color: TextProps['color']
  backgroundColor?: TextProps['backgroundColor']
  dimColor?: boolean
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
  shimmerColor?: keyof Theme
  priority: number
}

export type TextSegment = {
  text: string
  start: number
  highlight?: TextHighlight
}

export function segmentTextByHighlights(
  text: string,
  highlights: TextHighlight[],
): TextSegment[] {
  if (highlights.length === 0) {
    return [{ text, start: 0 }]
  }

  return new HighlightSegmenter(text).segment(resolveTextHighlights(highlights))
}

function resolveTextHighlights(highlights: TextHighlight[]): TextHighlight[] {
  const sorted = [...highlights].sort((a, b) => a.start - b.start || b.priority - a.priority)
  const resolved: TextHighlight[] = []
  let end = -Infinity
  for (const highlight of sorted) {
    if (highlight.start === highlight.end) continue
    if (highlight.start >= end) {
      resolved.push(highlight)
      end = Math.max(end, highlight.end)
    }
  }
  return resolved
}

export function mergePromptDecorations(
  highlights: TextHighlight[],
  decorations: readonly PromptDecoration[],
  theme: Theme,
  cursor?: {start: number; end: number},
): TextHighlight[] {
  if (!decorations.length) return highlights
  const base = resolveTextHighlights(cursor ? highlights.filter(run =>
    run.dimColor === true || cursor.start < run.start || cursor.start >= run.end,
  ) : highlights)
  const edges = [...new Set([...base, ...decorations].flatMap(run => [run.start, run.end]))].sort((a, b) => a - b)
  const isColor = (value: string | undefined): value is NonNullable<TextProps['color']> => {
    if (value === undefined) return false
    const raw = /^rgb\(\s?\d{1,3},\s?\d{1,3},\s?\d{1,3}\s?\)$/.test(value) ||
      /^#[0-9a-fA-F]{6}$/.test(value) || /^#[0-9a-fA-F]{3}$/.test(value) ||
      /^ansi256\(\d{1,3}\)$/.test(value) || /^ansi:(black|red|green|yellow|blue|magenta|cyan|white)(Bright)?$/.test(value)
    return raw || value !== 'messageActionsBackground' && Object.hasOwn(theme, value)
  }
  return edges.flatMap((end, i) => {
    const start = edges[i - 1] ?? end
    if (start === end) return []
    const inherited = base.find(run => run.start <= start && run.end > start)
    const paint = decorations.find(run => run.start <= start && run.end > start)
    if (!inherited && !paint) return []
    const merged: TextHighlight = inherited ? {...inherited, start, end} : {start, end, color: undefined, priority: 0}
    if (!paint) return [merged]
    if (isColor(paint.color)) {merged.color = paint.color;merged.shimmerColor = undefined}
    if (isColor(paint.backgroundColor)) merged.backgroundColor = paint.backgroundColor
    for (const key of ['dimColor', 'bold', 'italic', 'underline', 'strikethrough'] as const)
      if (paint[key] !== undefined) merged[key] = paint[key]
    if (!cursor || cursor.start === cursor.end || cursor.end <= start || cursor.start >= end) return [merged]
    return [
      ...(cursor.start > start ? [{...merged, end: cursor.start}] : []),
      ...(inherited ? [{...inherited, start: Math.max(start, cursor.start), end: Math.min(end, cursor.end)}] : []),
      ...(cursor.end < end ? [{...merged, start: cursor.end}] : []),
    ]
  })
}

class HighlightSegmenter {
  private readonly tokens: Token[]
  // Two position systems: "visible" (what the user sees, excluding ANSI codes)
  // and "string" (raw positions including ANSI codes for substring extraction)
  private visiblePos = 0
  private stringPos = 0
  private tokenIdx = 0
  private charIdx = 0 // offset within current text token (for partial consumption)
  private codes: AnsiCode[] = []

  constructor(private readonly text: string) {
    this.tokens = tokenize(text)
  }

  segment(highlights: TextHighlight[]): TextSegment[] {
    const segments: TextSegment[] = []

    for (const highlight of highlights) {
      const before = this.segmentTo(highlight.start)
      if (before) segments.push(before)

      const highlighted = this.segmentTo(highlight.end)
      if (highlighted) {
        highlighted.highlight = highlight
        segments.push(highlighted)
      }
    }

    const after = this.segmentTo(Infinity)
    if (after) segments.push(after)

    return segments
  }

  private segmentTo(targetVisiblePos: number): TextSegment | null {
    if (
      this.tokenIdx >= this.tokens.length ||
      targetVisiblePos <= this.visiblePos
    ) {
      return null
    }

    const visibleStart = this.visiblePos

    // Consume leading ANSI codes before first visible char
    while (this.tokenIdx < this.tokens.length) {
      const token = this.tokens[this.tokenIdx]!
      if (token.type !== 'ansi') break
      this.codes.push(token)
      this.stringPos += token.code.length
      this.tokenIdx++
    }

    const stringStart = this.stringPos
    const codesStart = [...this.codes]

    // Advance through tokens until we reach target
    while (
      this.visiblePos < targetVisiblePos &&
      this.tokenIdx < this.tokens.length
    ) {
      const token = this.tokens[this.tokenIdx]!

      if (token.type === 'ansi') {
        this.codes.push(token)
        this.stringPos += token.code.length
        this.tokenIdx++
      } else {
        const charsNeeded = targetVisiblePos - this.visiblePos
        // @ts-ignore - recovered code
        const charsAvailable = token.value.length - this.charIdx
        const charsToTake = Math.min(charsNeeded, charsAvailable)

        this.stringPos += charsToTake
        this.visiblePos += charsToTake
        this.charIdx += charsToTake

        // @ts-ignore - recovered code
        if (this.charIdx >= token.value.length) {
          this.tokenIdx++
          this.charIdx = 0
        }
      }
    }

    // Empty segment (can occur when only trailing ANSI codes remain)
    if (this.stringPos === stringStart) {
      return null
    }

    const prefixCodes = reduceCodes(codesStart)
    const suffixCodes = reduceCodes(this.codes)
    this.codes = suffixCodes

    const prefix = ansiCodesToString(prefixCodes)
    const suffix = ansiCodesToString(undoAnsiCodes(suffixCodes))

    return {
      text: prefix + this.text.substring(stringStart, this.stringPos) + suffix,
      start: visibleStart,
    }
  }
}

function reduceCodes(codes: AnsiCode[]): AnsiCode[] {
  return reduceAnsiCodes(codes).filter(c => c.code !== c.endCode)
}
