import type { EffortValue } from './effort.js'

type TriggerPosition = { word: string; start: number; end: number }

export function findUltracodeTriggerPositions(text: string): TriggerPosition[] {
  if (text.startsWith('/')) return []
  const positions: TriggerPosition[] = []
  for (const match of text.matchAll(/\bultracode\b/gi)) {
    if (match.index === undefined) continue
    const start = match.index
    const end = start + match[0].length
    const before = text[start - 1]
    const after = text[end]
    if (before === '/' || before === '\\' || before === '-') continue
    if (after === '/' || after === '\\' || after === '-' || after === '?') continue
    if (after === '.' && /[\p{L}\p{N}_]/u.test(text[end + 1] ?? '')) continue
    positions.push({ word: match[0], start, end })
  }
  return positions
}

export function hasUltracodeKeyword(text: string): boolean {
  return findUltracodeTriggerPositions(text).length > 0
}

export function isUltracodeKeywordTriggerEnabled(settings: { ultracodeKeywordTrigger?: boolean } | undefined): boolean {
  return settings?.ultracodeKeywordTrigger !== false
}

export function shouldInjectUltracodeOrchestration(
  effortValue: EffortValue | undefined,
): boolean {
  return effortValue === 'ultracode'
}

export function getUltracodeNotificationText(): string {
  return 'Dynamic workflow requested for this turn · opt+w to ignore'
}
