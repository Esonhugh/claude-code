import { useEffect, useMemo, useState } from 'react'
import { useAppState } from '../state/AppState.js'
import {
  disposeSpellChecker,
  findSpellcheckWords,
  getSpellcheckSettings,
  getSpellChecker,
  isPlainDictionaryName,
  resolveSpellCheckerName,
  resolveSpellcheckColor,
  type SpellChecker,
} from '../utils/spellcheck.js'
import type { TextHighlight } from '../utils/textHighlighting.js'

const REQUEST_DEBOUNCE_MS = 250
const EMPTY: TextHighlight[] = []

/**
 * Underlines misspelled words in the prompt (official 2.1.303 `spellcheck`).
 * The word still being typed at the cursor is left alone, as are words that
 * overlap `skip` ranges such as paste placeholders.
 */
export function useSpellcheckHighlights({
  text,
  cursorOffset,
  active,
  skip,
}: {
  text: string
  cursorOffset: number
  active: boolean
  skip: ReadonlyArray<{ start: number; end: number }>
}): TextHighlight[] {
  // Re-read when settings change; the block itself comes from user/flag/policy only.
  const settingsVersion = useAppState(s => s.settings)
  const settings = useMemo(() => getSpellcheckSettings(), [settingsVersion])
  const enabled = settings?.enabled === true
  const checkerName = resolveSpellCheckerName(enabled ? settings.checker?.trim() || undefined : undefined)
  const rawLanguage = enabled ? settings.language?.trim() || undefined : undefined
  const language = rawLanguage !== undefined && isPlainDictionaryName(rawLanguage) ? rawLanguage : undefined
  const color = useMemo(
    () => resolveSpellcheckColor(enabled ? settings.color : undefined),
    [enabled, settings?.color],
  )

  const [checker, setChecker] = useState<SpellChecker | undefined>()
  useEffect(() => {
    if (enabled) setChecker(getSpellChecker(checkerName, language))
    else {
      disposeSpellChecker()
      setChecker(undefined)
    }
  }, [enabled, checkerName, language])

  // Bumped whenever the checker records new verdicts.
  const [verdictVersion, setVerdictVersion] = useState(0)
  useEffect(() => checker?.changed.subscribe(() => setVerdictVersion(n => n + 1)), [checker])

  const words = useMemo(() => {
    if (!checker || !active) return []
    return findSpellcheckWords(text).filter(
      word => !skip.some(range => word.start < range.end && word.end > range.start),
    )
  }, [checker, active, text, skip])

  const isTyping = (word: { end: number }) =>
    cursorOffset >= word.end && /^['’]*$/.test(text.slice(word.end, cursorOffset))

  const unknown = words
    .filter(word => !isTyping(word) && checker?.isMisspelled(word.word) === undefined)
    .map(word => word.word)
    .join('\n')
  useEffect(() => {
    if (!checker || !unknown) return
    const timer = setTimeout(() => checker.request(unknown.split('\n')), REQUEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [checker, unknown])

  return useMemo(() => {
    const highlights = words
      .filter(word => !isTyping(word) && checker?.isMisspelled(word.word) === true)
      .map(word => ({
        start: word.start,
        end: word.end,
        color: color as TextHighlight['color'],
        underline: true,
        priority: 2,
      }))
    return highlights.length > 0 ? highlights : EMPTY
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, checker, color, cursorOffset, verdictVersion])
}
