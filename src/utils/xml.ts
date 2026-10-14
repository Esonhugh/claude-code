/**
 * Escape XML/HTML special characters for safe interpolation into element
 * text content (between tags). Use when untrusted strings (process stdout,
 * user input, external data) go inside `<tag>${here}</tag>`.
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escape for interpolation into a double- or single-quoted attribute value:
 * `<tag attr="${here}">`. Escapes quotes in addition to `& < >`.
 */
export function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Official closing-tag escape for untrusted text inside a wrapper tag, including
// invisible separators and bracket/slash lookalikes. Escaped '<\\' is left unchanged.
const invisible = '\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}'
const marks = '\\u0300-\\u0344\\u0346-\\u036f\\u0483-\\u0489\\u0591-\\u05bd\\u05bf\\u05c1\\u05c2\\u05c4\\u05c5\\u05c7\\u0610-\\u061a\\u064b-\\u065f\\u0670\\u06d6-\\u06dc\\u06df-\\u06e4\\u06e7\\u06e8\\u06ea-\\u06ed\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\u3099\\u309a\\ufe20-\\ufe2f'
const separators = `[${invisible}${marks}\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u2028\\u2029]*`
const opening = '<\uFF1C\uFE64\u2329\u27E8\u3008\u2039\u02C2\u1438\u276C\u276E\u2770\u29FC\u226E\u227A\u22D6'
const closing = '>\uFF1E\uFE65\u232A\u27E9\u3009\u203A\u02C3\u1433\u276D\u276F\u2771\u29FD\u226F\u227B\u22D7'
const filler = `[^A-Za-z0-9_\\-${opening}${closing}]*`
const closingTags = new Map<string, RegExp>()

/** Neutralize every closing `</tag>` (and its lookalikes) in `text` as `<\\/tag>`. */
export function escapeClosingTag(text: string, tag: string): string {
  let pattern = closingTags.get(tag)
  if (!pattern) {
    // Each combining mark is an individual separator, not a composed character.
    // eslint-disable-next-line no-misleading-character-class
    pattern = new RegExp(`[${opening}](?!\\\\)(?=${filler}[/\uFF0F\u2215\u2044]${filler}${[...tag].join(separators)}(?:[^A-Za-z0-9_\\-]|$))`, 'giu')
    closingTags.set(tag, pattern)
  }
  return text.replace(pattern, '<\\')
}
