const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u

/**
 * Official `kpe` (2.1.325 chunk-aay5maza.js) without its secret redaction: a
 * description's first line, trimmed, or '' when it is blank or holds a
 * character a terminal would not show plainly.
 */
export function replScriptLabel(text: unknown): string {
  if (typeof text !== 'string') return ''
  const line = text.split('\n')[0]!.replace(/\r$/, '')
  return UNSHOWABLE.test(line) ? '' : line.trim()
}
