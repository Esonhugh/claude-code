import { Buffer } from 'buffer'
import { BEL, ESC } from '../../ink/termio/ansi.js'
import { OSC, OSC_PREFIX, ST, wrapForMultiplexer } from '../../ink/termio/osc.js'
import { logForDebugging } from '../debug.js'
import { env } from '../env.js'

// Official 2.1.329 (`MDr`/`ilt`): a hook's `terminalSequence` may only set the
// title or post a notification. Anything else drops the whole sequence.
const ALLOWED_OSC = new Set<number>([OSC.SET_TITLE_AND_ICON, OSC.SET_ICON, OSC.SET_TITLE, OSC.ITERM2, OSC.KITTY, OSC.GHOSTTY])
const MAX_BYTES = 4096

export const TERMINAL_SEQUENCE_REJECTED =
  'returned a terminalSequence that was rejected by the allowlist (only OSC 0/1/2/9/99/777 and BEL are permitted, and OSC 9 bodies may not begin with a digit unless in the 9;4 progress form)'

type Part = { kind: 'bel' } | { kind: 'osc'; ps: number; payload: string }

function dropControls(payload: string): string {
  let kept = ''
  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i)
    if (code >= 32 && code !== 127 && !(code >= 128 && code <= 159)) kept += payload[i]
  }
  return kept
}

// OSC 9 with a leading digit is ConEmu's command space; only its 9;4 progress form is a notification.
function isNotificationBody(payload: string): boolean {
  if (/^4;[0-4](;(100|\d{1,2})?)?$/.test(payload)) return true
  return !/^[\s\u180e\u200b]*[+-]?\p{Nd}/u.test(payload)
}

function parse(sequence: string): Part[] | null {
  if (sequence.length === 0 || Buffer.byteLength(sequence, 'utf8') > MAX_BYTES) return null
  const parts: Part[] = []
  let i = 0
  while (i < sequence.length) {
    if (sequence[i] === BEL) {
      parts.push({ kind: 'bel' })
      i++
      continue
    }
    if (sequence[i] !== ESC || sequence[i + 1] !== ']') return null
    let end = -1
    let terminator = 0
    for (let j = i + 2; j < sequence.length; j++) {
      if (sequence[j] === BEL) {
        end = j
        terminator = 1
        break
      }
      if (sequence[j] === ESC && sequence[j + 1] === '\\') {
        end = j
        terminator = 2
        break
      }
      if (sequence[j] === ESC) return null
    }
    if (end === -1) return null
    const body = sequence.slice(i + 2, end)
    const semicolon = body.indexOf(';')
    const ps = semicolon === -1 ? body : body.slice(0, semicolon)
    if (!/^\d+$/.test(ps) || !ALLOWED_OSC.has(Number(ps))) return null
    const payload = dropControls(semicolon === -1 ? '' : body.slice(semicolon + 1))
    if (Number(ps) === OSC.ITERM2 && !isNotificationBody(payload)) return null
    parts.push({ kind: 'osc', ps: Number(ps), payload })
    i = end + terminator
  }
  return parts
}

/** The sequence rebuilt from its allowed parts for this terminal, or null when any part is not allowed. */
export function sanitizeTerminalSequence(sequence: string): string | null {
  const parts = parse(sequence)
  if (parts === null) return null
  return parts.map(part => {
    if (part.kind === 'bel') return BEL
    // Kitty's notification protocol ends with ST unless GNU screen would cut it short.
    const st = env.terminal === 'kitty' || (part.ps === OSC.KITTY && (process.env.TMUX || !process.env.STY))
    return wrapForMultiplexer(`${OSC_PREFIX}${part.ps};${part.payload}${st ? ST : BEL}`)
  }).join('')
}

type Writer = (data: string) => void
const writers: Writer[] = []

/** The interactive screen writes hook sequences while it is mounted; without one (`-p`, SDK) they are dropped. */
export function registerHookTerminalWriter(writer: Writer): () => void {
  writers.push(writer)
  return () => {
    const index = writers.lastIndexOf(writer)
    if (index >= 0) writers.splice(index, 1)
  }
}

export function writeHookTerminalSequence(sequence: string): void {
  writers.at(-1)?.(sequence)
}

/** Official `X5e`: a hook run outside a turn emits its allowed sequence right away. */
export function emitHookTerminalSequence(sequence: string | undefined, hookName: string): void {
  if (!sequence) return
  const sanitized = sanitizeTerminalSequence(sequence)
  if (sanitized !== null) writeHookTerminalSequence(sanitized)
  else logForDebugging(`Hook ${hookName} ${TERMINAL_SEQUENCE_REJECTED}`)
}
