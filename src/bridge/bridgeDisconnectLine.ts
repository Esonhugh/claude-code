import type { Message } from '../types/message.js'
import { createSystemMessage } from '../utils/messages.js'
import { detailSaysWhatToDo } from './bridgeFailure.js'
import type { BridgeErrorKind } from './replBridge.js'

function nextStepHint(detail: string | undefined, kind: BridgeErrorKind): string {
  if (kind === 'auth') {
    return detail?.includes('/login') ? '' : ' — run /login to restore Remote Control'
  }
  if (kind === 'ended_elsewhere' || detailSaysWhatToDo(detail)) return ''
  return ' — run /remote-control to reconnect'
}

/** The transcript line for a Remote Control failure (official 2.1.325 useReplBridge). */
export function bridgeDisconnectedLine(
  detail: string | undefined,
  kind: BridgeErrorKind = 'terminal',
): string {
  return `Remote Control disconnected${detail ? ` — ${detail}` : ''}${nextStepHint(detail, kind)}`
}

/** Adds the line as a warning row, unless the last row already says it. */
export function withBridgeDisconnectedLine(
  messages: Message[],
  detail: string | undefined,
  kind: BridgeErrorKind = 'terminal',
): Message[] {
  const line = bridgeDisconnectedLine(detail, kind)
  const last = messages.at(-1)
  if (last?.type === 'system' && last.subtype === 'informational' && last.content === line) return messages
  return [...messages, createSystemMessage(line, 'warning')]
}
