// Headless twins of /cd and /rewind for SDK hosts (official 2.1.316
// set_cwd and rewind_conversation). Both refuse while a turn is in flight.
import { realpathSync, statSync } from 'fs'
import { resolve } from 'path'
import { addCwdToAdditionalWorkingDirectories } from '../commands/cd/cd.js'
import type { AppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isPathTrusted, savePathTrusted } from '../utils/config.js'
import { prepareConversationRewind } from '../utils/conversationRewind.js'
import { getCwd } from '../utils/cwd.js'
import { changeSessionCwd } from '../utils/cwdChange.js'
import { textForResubmit } from '../utils/messages.js'
import { selectableUserMessagesFilter } from '../components/MessageSelector.js'
import { expandTilde } from '../utils/path.js'

type SetAppState = (f: (prev: AppState) => AppState) => void

// Characters that do not render as a visible, distinguishable glyph; a trust
// dialog must never show such a path.
const UNSAFE_PATH = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}⠀ᅟᅠㅤﾠ]|(?! )\p{Zs}/u

export type SetCwdResponse =
  | { status: 'ok'; cwd: string; changed: boolean; transcript_relocated: boolean }
  | { status: 'needs_trust'; directory: string }
  | { status: 'rejected'; reason: 'not_found' | 'not_a_directory' | 'busy' | 'unsafe_path'; message: string }

export function handleSetCwd(
  request: Record<string, unknown>,
  host: { busy: boolean; getAppState: () => AppState; setAppState: SetAppState },
): SetCwdResponse | { error: string } {
  const { path, trust_accepted: trustAccepted, trusted_directory: trustedDirectory } = request
  if (typeof path !== 'string' || !path) return { error: 'set_cwd: path must be a non-empty string' }
  if (trustAccepted !== undefined && typeof trustAccepted !== 'boolean') {
    return { error: 'set_cwd: trust_accepted must be a boolean' }
  }
  if (trustAccepted === true && typeof trustedDirectory !== 'string') {
    return { error: 'set_cwd: invalid request — trust_accepted requires trusted_directory (echo the directory from the needs_trust response)' }
  }
  if (host.busy) {
    return { status: 'rejected', reason: 'busy', message: 'A turn is in progress; try again once the session is idle.' }
  }
  const target = resolve(getCwd(), expandTilde(path))
  let directory: string
  try {
    directory = realpathSync(target)
  } catch {
    return { status: 'rejected', reason: 'not_found', message: `Couldn't find a directory at ${target}.` }
  }
  if (UNSAFE_PATH.test(directory)) {
    return { status: 'rejected', reason: 'unsafe_path', message: 'The directory path contains characters that cannot be shown safely.' }
  }
  if (!statSync(directory).isDirectory()) {
    return { status: 'rejected', reason: 'not_a_directory', message: `${directory} is not a directory.` }
  }
  const before = getCwd()
  if (directory === before) return { status: 'ok', cwd: before, changed: false, transcript_relocated: true }
  if (!isPathTrusted(directory)) {
    if (trustAccepted !== true || trustedDirectory !== directory) return { status: 'needs_trust', directory }
    savePathTrusted(directory)
  }
  const cwd = changeSessionCwd(directory)
  addCwdToAdditionalWorkingDirectories(host, cwd)
  // Like /cd, the transcript stays in the launch directory's project slot.
  return { status: 'ok', cwd, changed: true, transcript_relocated: false }
}

const REWIND_REFUSED = { rewound: false, prefillText: null, precedingAssistantUuid: null } as const

/**
 * Fork-only: the uuids /rewind would list (oldest first), so a host offers
 * rewind exactly where rewind_conversation accepts it.
 */
export function handleRewindPoints(host: { messages: readonly Message[] }) {
  return { uuids: host.messages.filter(selectableUserMessagesFilter).map(m => m.uuid) }
}

/**
 * Drops the target user message and everything after it, like picking it in
 * /rewind. prefillText is what the REPL would put back in the prompt.
 * last_seen_user_message_uuid must name the newest prompt.
 */
export function handleRewindConversation(
  request: Record<string, unknown>,
  host: { messages: Message[]; busy: boolean; queued: boolean; setAppState: SetAppState },
) {
  const uuid = request.target_message_uuid
  if (typeof uuid !== 'string') return { error: 'rewind_conversation: target_message_uuid must be a string' }
  if (host.busy) return { ...REWIND_REFUSED, error: 'turn running', reason: 'turn_running' }
  if (host.queued) return { ...REWIND_REFUSED, error: 'commands queued', reason: 'commands_queued' }
  const prompts = host.messages.filter(selectableUserMessagesFilter)
  // The host names the newest prompt it has shown, so a rewind never drops a
  // turn the user has not seen.
  const lastSeen = request.last_seen_user_message_uuid
  if (prompts.at(-1)?.uuid !== lastSeen) {
    return prompts.some(m => m.uuid === lastSeen)
      ? { ...REWIND_REFUSED, error: 'unseen later turn', reason: 'unseen_later_turn' }
      : { ...REWIND_REFUSED, error: 'stale target', reason: 'stale_target' }
  }
  const target = prompts.find(m => m.uuid === uuid)
  const plan = target && prepareConversationRewind(host.messages, target)
  if (!target || !plan) return { ...REWIND_REFUSED, error: 'target not found', reason: 'target_not_found' }
  host.messages.splice(plan.messages.length)
  host.setAppState(plan.updateAppState)
  const preceding = plan.messages.findLast(m => m.type === 'assistant')
  return {
    rewound: true,
    targetMessageUuid: uuid,
    prefillText: textForResubmit(target)?.text ?? null,
    precedingAssistantUuid: preceding?.uuid ?? null,
  }
}
