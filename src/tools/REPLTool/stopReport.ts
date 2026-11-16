import { inspect, types } from 'node:util'
import type { REPLToolCallProgress } from '../../types/tools.js'
import { scriptValue } from './resultBlocks.js'

/**
 * The error a script stopped by the user ends with: official 325 `Fms`/`A`,
 * listing the tool calls the script started. Official `qu` picks the variant:
 * "refusal" when the user declined an inner call's permission prompt (which
 * stops the turn and so the script), "user" for a "user-cancel" or
 * "remote-cancel" stop.
 */

/** One tool call the script started, in the order it started (official `Zu` input). */
export type ReplCallRecord = {
  toolName: string
  toolInput: unknown
  phase: REPLToolCallProgress['phase']
  /** The call's own result, base64 included; scripts see `scriptValue` of it. */
  value?: unknown
  /** Official `mcpContent`: the value is an MCP tool's content blocks. */
  mcpContent?: boolean
  error?: string
  /** The user declined its permission prompt, which stopped the script. */
  declined?: boolean
}

/** Why the script stopped (official `qu`). */
export type ReplStop = { by: 'user' | 'refusal'; calls: ReplCallRecord[] }

type CallState = 'finished' | 'failed' | 'running' | 'waiting' | 'declined'
type StoppedCall = { toolName: string; toolInput: unknown; state: CallState; text?: string }

/** Official `Mae`. */
const LIMITS = {
  nameChars: 80,
  inputChars: 200,
  valueChars: 2000,
  valuesChars: 8000,
  valueMinChars: 200,
  entries: 30,
  namesPerCount: 5,
  reportChars: 24000,
}
/** Official `GLt`. */
export const STOP_AND_WAIT = 'STOP what you are doing and wait for the user to tell you how to proceed.'
/** Official `gja`. */
const DECLINED = "The user doesn't want to proceed with this tool use."
/** Official `Lu`: keys `za` leaves to inspect. */
const RESULT_KEYS = new Set(['stdout', 'stderr', 'error', 'result'])
const INDENT = '  '
const VALUE_BREAKS = /\r\n?|[\v\f\u0085\u2028\u2029]/g
const NAME_BREAKS = /\r\n?|[\n\v\f\u0085\u2028\u2029]/g
const EXCERPT_MARGIN = 100
const MAX_KEYS = 20
const NOT_SHOWN = '(not shown)'

/** Official `oi(reason)` check in `qu`. */
export function isUserStop(reason: unknown): boolean {
  return reason === 'user-cancel' || reason === 'remote-cancel'
}

/** Official `qu` after its gate: a declined call makes it a refusal, whatever the abort reason. */
export function replStopOf(reason: unknown, calls: ReplCallRecord[]): ReplStop | undefined {
  if (calls.some(call => call.declined === true)) return { by: 'refusal', calls }
  return isUserStop(reason) ? { by: 'user', calls } : undefined
}

/**
 * Official `nOi`: the line after the error of a script that ran and then threw
 * or was stopped (not one a stop report replaces), counting the calls that completed.
 */
export function partwayNote(calls: readonly ReplCallRecord[], stopped: boolean): string {
  const completed = new Map<string, number>()
  for (const call of calls) if (call.phase === 'complete') completed.set(call.toolName, (completed.get(call.toolName) ?? 0) + 1)
  const head = stopped
    ? 'The script was stopped partway through: statements before the stop ran.'
    : 'The script threw partway through: statements before the failing one ran.'
  if (completed.size === 0) return `${head} No tool call had completed.`
  return `${head} Tool calls that had completed: ${[...completed].map(([name, n]) => `${name} \u00d7${n}`).join(', ')}.`
}

/** Official `Zu`: a call that had not got a concurrency slot was waiting; one that had, running. */
function stoppedCalls(calls: readonly ReplCallRecord[]): StoppedCall[] {
  return calls.map((c, i) => {
    const call = { toolName: c.toolName, toolInput: c.toolInput }
    const listed = i < LIMITS.entries
    switch (c.phase) {
      case 'complete':
        return { ...call, state: 'finished', ...(listed && { text: valueText(scriptValue(c, c.value)) }) }
      case 'error':
        return c.declined === true
          ? { ...call, state: 'declined' }
          : { ...call, state: 'failed', ...(listed && { text: c.error ?? '' }) }
      case 'start':
        return { ...call, state: 'waiting' }
      case 'executing':
        return { ...call, state: 'running' }
    }
  })
}

/** Official `mo(value, 10)`: text as is, a shell result's output, a record of texts, else inspected. */
function valueText(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  const output = shellOutput(value)
  if (output !== undefined && output.trim() !== '') return output
  const texts = textRecord(value)
  if (texts !== undefined) return texts
  return inspect(value, { colors: false, depth: 10, customInspect: false })
}

/** Official `Cn`: the `output` of a `{ output, stdout, exitCode }` shell result. */
function shellOutput(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return undefined
  try {
    const own = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return descriptor !== undefined && 'value' in descriptor ? (descriptor.value as unknown) : undefined
    }
    const output = own('output')
    const exitCode = own('exitCode')
    return typeof output === 'string' && typeof own('stdout') === 'string' && (typeof exitCode === 'number' || exitCode === null)
      ? output
      : undefined
  } catch {
    return undefined
  }
}

/** Official `za`: a plain object whose values are all text, as `key:\nvalue` blocks. */
function textRecord(value: unknown): string | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const proto: unknown = Object.getPrototypeOf(value)
    if (proto === null || Object.getPrototypeOf(proto) !== null) return undefined
    const entries: [string, string][] = []
    for (const [key, entry] of Object.entries(value)) {
      const text = typeof entry === 'string' ? entry : shellOutput(entry)
      if (text === undefined || RESULT_KEYS.has(key)) return undefined
      entries.push([key, text])
    }
    if (entries.length === 0) return undefined
    return entries.map(([key, text]) => `${key}:\n${text}`).join('\n\n')
  } catch {
    return undefined
  }
}

/** The error for a stopped script (official `A` with no tail). */
export function replStopReport(stop: ReplStop): string {
  const stopped = stoppedCalls(stop.calls)
  const declined = stopped.find(call => call.state === 'declined')
  const headline =
    stop.by === 'refusal' && declined !== undefined
      ? `${DECLINED} ${STOP_AND_WAIT} The user declined the permission prompt for ${callLabel(declined)}, so the script stopped.`
      : `The user interrupted this script, so it stopped. ${STOP_AND_WAIT}`
  if (stopped.length === 0) return fitReport(`${headline}\nThe script had not started any tool calls.`)
  const lines = [headline, 'Tool calls the script started, in order:']
  let budget = LIMITS.valuesChars
  stopped.slice(0, LIMITS.entries).forEach((call, i) => {
    const head = `${i + 1}. ${callLabel(call)}`
    switch (call.state) {
      case 'running':
        lines.push(`${head} was still running when the script stopped. The script got no result, and the call may have run in part or in full.`)
        return
      case 'waiting':
        lines.push(`${head} was waiting to run when the script stopped. The script got no result, and the call may still have run afterwards.`)
        return
      case 'declined':
        lines.push(`${head} did not run. The user declined it.`)
        return
      case 'finished':
      case 'failed': {
        const text = (call.text ?? '').replace(VALUE_BREAKS, '\n')
        if (text === '') {
          lines.push(call.state === 'failed' ? `${head} failed with no error message.` : `${head} finished. Its result is empty.`)
          return
        }
        const kind = call.state === 'finished' ? 'result' : 'error'
        if (budget < LIMITS.valueMinChars && indent(text).length > budget) {
          lines.push(`${head} ${call.state}. Its ${kind} (${count(text.length)} characters) is not shown, to keep this report short.`)
          return
        }
        const shown = excerpt(text, Math.min(LIMITS.valueChars, budget))
        budget -= shown.length
        lines.push(call.state === 'finished' ? `${head} finished. It returned:\n${shown}` : `${head} failed with this error:\n${shown}`)
      }
    }
  })
  const rest = stopped.slice(LIMITS.entries)
  if (rest.length === 1) lines.push(`1 more tool call is not listed: ${summarize(rest)}.`)
  else if (rest.length > 1) lines.push(`${rest.length} more tool calls are not listed: ${summarize(rest)}.`)
  lines.push('That is every tool call the script started.')
  return fitReport(lines.join('\n'))
}

/** Official `S` with an empty tail. */
function fitReport(text: string): string {
  const max = LIMITS.reportChars
  if (text.length <= max) return text
  const marker = `\n... [this report was cut at ${count(max)} characters, so its list is incomplete] ...`
  return cutAt(text, max - marker.length) + marker
}

/** Official `g`: the first `n` UTF-16 units, without a lone high surrogate at the end. */
function cutAt(text: string, n: number): string {
  const head = text.slice(0, n)
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
}

/** Official `I`: the last `n` UTF-16 units, without a lone low surrogate at the start. */
function lastOf(text: string, n: number): string {
  const tail = n > 0 ? text.slice(-n) : ''
  return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail
}

function clip(text: string, n: number): string {
  return text.length > n ? `${cutAt(text, n)}\u2026` : text
}

/** Official `E`: `Name({"key":"value"})`, each part clipped. */
function callLabel(call: StoppedCall): string {
  const input = clip(escapeBreaks(JSON.stringify(shallow(call.toolInput)) ?? ''), LIMITS.inputChars)
  return `${clip(escapeBreaks(call.toolName), LIMITS.nameChars)}(${input})`
}

/** Official `j`: the first 20 own keys, with only plain values shown. */
function shallow(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return plain(input)
  if (Array.isArray(input)) return [NOT_SHOWN]
  const out: Record<string, unknown> = {}
  let keys = 0
  for (const key in input) {
    if (keys === MAX_KEYS) break
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (descriptor === undefined) continue
    keys++
    out[clip(key, LIMITS.inputChars)] = 'value' in descriptor ? plain(descriptor.value) : NOT_SHOWN
  }
  return out
}

function plain(value: unknown): unknown {
  if (typeof value === 'string') return clip(value, LIMITS.inputChars)
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value
  return NOT_SHOWN
}

function escapeBreaks(text: string): string {
  return text.replace(NAME_BREAKS, found => [...found].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))
}

function indent(text: string): string {
  return INDENT + text.replaceAll('\n', `\n${INDENT}`)
}

/** Official `VSr`: the value indented, its middle cut out when it is longer than `max`. */
function excerpt(text: string, max: number): string {
  const whole = indent(text)
  if (whole.length <= max) return whole
  const room = Math.max(0, max - EXCERPT_MARGIN)
  const headRoom = Math.floor(room * 0.6)
  const head = headChars(text, headRoom)
  const tail = tailChars(text, room - headRoom)
  const cut = text.length - head.length - tail.length
  return `${indent(head)}\n${INDENT}... [the middle ${count(cut)} of its ${count(text.length)} characters are not shown] ...\n${indent(tail)}`
}

const shownWidth = (c: string) => (c === '\n' ? 1 + INDENT.length : 1)

function headChars(text: string, max: number): string {
  let width = INDENT.length
  let i = 0
  while (i < text.length && width + shownWidth(text[i]!) <= max) width += shownWidth(text[i++]!)
  return cutAt(text, i)
}

function tailChars(text: string, max: number): string {
  let width = INDENT.length
  let i = text.length
  while (i > 0 && width + shownWidth(text[i - 1]!) <= max) width += shownWidth(text[--i]!)
  return lastOf(text, text.length - i)
}

/** Official `k`: the unlisted calls counted by state, then by tool name. */
function summarize(calls: readonly StoppedCall[]): string {
  const states: [CallState, string, string][] = [
    ['finished', 'finished', 'finished'],
    ['failed', 'failed', 'failed'],
    ['running', 'was still running', 'were still running'],
    ['waiting', 'was waiting to run', 'were waiting to run'],
    ['declined', 'was declined', 'were declined'],
  ]
  const parts: string[] = []
  for (const [state, one, many] of states) {
    const byName = new Map<string, number>()
    for (const call of calls)
      if (call.state === state) {
        const name = clip(escapeBreaks(call.toolName), LIMITS.nameChars)
        byName.set(name, (byName.get(name) ?? 0) + 1)
      }
    const total = [...byName.values()].reduce((a, b) => a + b, 0)
    if (total === 0) continue
    const named = [...byName].slice(0, LIMITS.namesPerCount)
    const others = byName.size - named.length
    const names = [
      ...named.map(([name, n]) => `${name} \u00D7${n}`),
      ...(others === 1 ? ['1 other tool'] : []),
      ...(others > 1 ? [`${others} other tools`] : []),
    ].join(', ')
    parts.push(`${total} ${total === 1 ? one : many} (${names})`)
  }
  return parts.join(', ')
}

function count(n: number): string {
  return n.toLocaleString('en-US')
}
