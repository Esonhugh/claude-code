import { createHash } from 'node:crypto'
import { z } from 'zod/v4'
import type { AppState } from '../state/AppStateStore.js'
import type { SetAppState } from '../Task.js'
import { toAgentId, type AgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'
import { formatDuration } from './format.js'

export type SendMessagePin = { id: string; name: string; ref: string }
export type SendMessagePins = Record<string, SendMessagePin>
type Recipient = SendMessagePin & { startTime?: number }

export function normalizeRecipientName(name: string): string {
  return name.normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, character => /\s/.test(character) ? character : '')
    .trim().toLowerCase().replace(/\s+/g, '-')
}

export function parseRecipientRef(to: string): { name: string; ref: string } | null {
  const match = /^(.*\S)\s*\[([0-9a-f]{6,12})\]$/.exec(to.trim())
  return match ? { name: match[1]!, ref: match[2]! } : null
}

function fingerprint(id: string): string {
  return createHash('sha256').update(`subagent:${id}`).digest('hex').slice(0, 12)
}

export function subagentRef(id: string): string {
  return fingerprint(id).slice(0, 6)
}

// Resolve this session's registered agents before the existing mailbox and
// peer-session transports. A displayed ref is exact, not an arbitrary prefix.
export function resolveSubagentRecipient(state: AppState, to: string):
  | { kind: 'one'; recipient: Recipient }
  | { kind: 'ambiguous'; candidates: Recipient[] }
  | null {
  const normalized = normalizeRecipientName(to)
  const rawId = toAgentId(to) ?? toAgentId(normalized)
  if (rawId) return { kind: 'one', recipient: { id: rawId, name: to, ref: subagentRef(rawId) } }
  const candidates: Recipient[] = [...state.agentNameRegistry].map(([name, id]) => ({
    id, name, ref: subagentRef(id), startTime: state.tasks[id]?.startTime,
  }))
  const fingerprints = [...new Set(candidates.map(candidate => fingerprint(candidate.id)))]
  for (const candidate of candidates) {
    const hash = fingerprint(candidate.id)
    let length = 6
    for (const other of fingerprints) {
      if (hash === other) continue
      let shared = 0
      while (shared < 12 && hash[shared] === other[shared]) shared++
      length = Math.max(length, shared + 1)
    }
    candidate.ref = hash.slice(0, length)
  }
  const explicit = parseRecipientRef(to)
  if (explicit) {
    const matching = candidates.find(candidate => normalizeRecipientName(candidate.name) === normalizeRecipientName(explicit.name) && candidate.ref === explicit.ref)
    return matching ? { kind: 'one', recipient: matching } : null
  }
  const exact = candidates.find(candidate => candidate.name === to)
    ?? candidates.find(candidate => normalizeRecipientName(candidate.name) === normalized)
  if (exact) return { kind: 'one', recipient: exact }
  if (normalized.length < 3) return null
  const prefixes = candidates.filter(candidate => normalizeRecipientName(candidate.name).startsWith(normalized))
  const names = new Set(prefixes.map(candidate => normalizeRecipientName(candidate.name)))
  if (names.size > 1) return { kind: 'ambiguous', candidates: prefixes }
  return prefixes[0] ? { kind: 'one', recipient: prefixes[0] } : null
}

export function bindSubagentRecipient(
  to: string,
  recipient: Recipient,
  state: AppState,
  setAppState: SetAppState,
): { kind: 'proceed'; pin?: SendMessagePin } | { kind: 'rebound'; message: string; display: string } {
  const key = normalizeRecipientName(recipient.name)
  const previous = Object.hasOwn(state.sendMessagePins, key) ? state.sendMessagePins[key] : undefined
  if (previous?.id === recipient.id) return { kind: 'proceed', pin: previous }
  if (previous && !parseRecipientRef(to)) {
    // A newly registered, different literal spelling is an explicit name
    // choice in the upstream resolver, even if its normalized key is shared.
    if (to === recipient.name && to !== previous.name) return { kind: 'proceed' }
    const age = recipient.startTime === undefined ? '' : `, started ${formatDuration(Math.max(0, Date.now() - recipient.startTime))} ago`
    return {
      kind: 'rebound',
      message: `'${recipient.name}' now resolves to a different agent than it did earlier in this conversation: earlier sends went to [${previous.ref}], which this name no longer reaches. Nothing was sent.\nIt now resolves to:\n  ${recipient.name} [${recipient.ref}] — subagent, in this session${age}\nTo message the new agent, re-send with its ref:\ne.g. {"to": "${recipient.name} [${recipient.ref}]", ...}\nIf you need the earlier agent and it is still running, address it by its agent ID from its spawn result.`,
      display: `Not sent — '${recipient.name}' now means a different agent than it did earlier in this conversation; asked Claude to confirm which one it wants.`,
    }
  }
  // Pins use the stable six-character identity ref, even if a discovery list
  // had to extend its display ref to distinguish a collision.
  const pin = { id: recipient.id, name: recipient.name, ref: subagentRef(recipient.id) }
  setAppState(previousState => ({ ...previousState, sendMessagePins: { ...previousState.sendMessagePins, [key]: pin } }))
  return { kind: 'proceed', pin }
}

const successfulReceipt = z.object({
  success: z.literal(true),
  pin: z.object({
    id: z.string().max(1024).refine(id => toAgentId(id) !== null),
    name: z.string().min(1).max(200),
    ref: z.string().regex(/^[0-9a-f]{6,12}$/),
  }),
})

/** Restore only matched, successful SendMessage metadata, never wire text. */
export function restoreSendMessagePins(messages: readonly Message[]): SendMessagePins {
  const sendUses = new Set<string>()
  const pins = new Map<string, SendMessagePin>()
  for (const message of messages) {
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && block.name === 'SendMessage' && typeof block.id === 'string') sendUses.add(block.id)
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      if (!message.message.content.some(block => block.type === 'tool_result' && !block.is_error && typeof block.tool_use_id === 'string' && sendUses.has(block.tool_use_id))) continue
      const result = successfulReceipt.safeParse(message.toolUseResult)
      if (result.success) pins.set(normalizeRecipientName(result.data.pin.name), result.data.pin)
    }
  }
  return Object.fromEntries(pins)
}

export function retainLiveAgentNames(names: AppState['agentNameRegistry'], tasks: AppState['tasks']): Map<string, AgentId> {
  return new Map([...names].filter(([, id]) => {
    const task = tasks[id] ?? Object.values(tasks).find(task => task.type === 'in_process_teammate' && 'resumableAgentId' in task.identity && task.identity.resumableAgentId === id)
    if (!task) return false
    if (task.status === 'running') return true
    return task.type === 'local_agent' && task.status === 'completed' && [...task.keepaliveReasons ?? []].some(reason => reason !== 'flag:idle-window')
  }))
}
