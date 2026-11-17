/**
 * The compaction note that tells the model which REPL bindings survived
 * (official 2.1.325 chunk-nhpp4fne: replStateNote / isReplStateNote).
 */

import { isCodeModeEnabled } from '../../tools/REPLTool/codeModeGate.js'

const MAX_LISTED_NAMES = 40
const MAX_NAME_CHARS = 80
const MAX_NOTE_CHARS = 4000
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const LEAD = 'Your REPL VM state was kept across this compaction'
const NOTE = new RegExp(
  `^${LEAD}(?:; no bindings are defined in it\\.|\\. (\\d{1,9}) bindings? (?:is|are) still defined in it, with names this note does not list\\.|\\. These bindings are still defined: ((?:\`[^\`]+\`, )*\`[^\`]+\`)(?:, and (\\d{1,9}) more this note does not list)?\\.)$`,
)

function isListableName(name: string): boolean {
  return name.length <= MAX_NAME_CHARS && IDENTIFIER.test(name)
}

function formatNote(listed: string[], unlisted: number): string {
  if (listed.length === 0 && unlisted === 0) return `${LEAD}; no bindings are defined in it.`
  if (listed.length === 0) {
    return `${LEAD}. ${unlisted} binding${unlisted === 1 ? ' is' : 's are'} still defined in it, with names this note does not list.`
  }
  return `${LEAD}. These bindings are still defined: ${listed.map(name => `\`${name}\``).join(', ')}${unlisted > 0 ? `, and ${unlisted} more this note does not list` : ''}.`
}

export function replStateNote(names: string[]): string {
  const listed = names.filter(isListableName).slice(0, MAX_LISTED_NAMES)
  return formatNote(listed, names.length - listed.length)
}

/** True only for text replStateNote could have produced. */
export function isReplStateNote(text: string): boolean {
  if (text.length > MAX_NOTE_CHARS) return false
  const match = NOTE.exec(text)
  if (match === null) return false
  const listed = match[2] === undefined ? [] : match[2].split(', ').map(name => name.slice(1, -1))
  const unlisted = Number(match[1] ?? match[3] ?? 0)
  if (listed.length > MAX_LISTED_NAMES || !listed.every(isListableName)) return false
  return formatNote(listed, unlisted) === text
}

/**
 * The summary text the UI shows: the note is for the model only (official
 * RAe). Removes `\n\n<note>` when it ends the text or a line.
 */
export function withoutReplStateNote(text: string, note: string | undefined): string {
  if (!note || !isReplStateNote(note)) return text
  const start = text.lastIndexOf(`\n\n${note}`)
  const end = start + 2 + note.length
  if (start !== -1 && (end === text.length || text[end] === '\n')) return text.slice(0, start) + text.slice(end)
  return text
}

/**
 * The note for a compaction in this context, or undefined when Code Mode is
 * off or no REPL context is live (official CVn). The session is looked up,
 * never made, so compacting does not start a Worker.
 */
export async function replStateNoteForCompaction(agentId: string | undefined): Promise<string | undefined> {
  if (!isCodeModeEnabled()) return undefined
  const { findReplSession, MAIN_REPL_SESSION } = await import('../../tools/REPLTool/sessions.js')
  const names = await findReplSession(agentId ?? MAIN_REPL_SESSION)?.executor.scriptGlobalNames()
  return names === undefined ? undefined : replStateNote(names)
}
