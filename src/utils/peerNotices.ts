// Notices that a cross-session sender receives about its own messages and idle
// subscriptions. Texts follow official Claude Code 2.1.303.
import { formatPeerAddress, PEER_IDLE_SUBSCRIPTION_CAP, type PeerInboundPolicy } from './peerProtocol.js'
import type { PeerIdleSubscribeResult } from './udsClient.js'

export type PeerSent = { endpoint: string; name?: string; msgId: string }
export type PeerNotice = { model?: string; transcript: string }
type ReceiptStatus = 'held' | 'denied' | 'expired' | 'delivered' | 'refused'

export const PEER_IDLE_SUBSCRIPTION_MS = 12 * 60 * 60 * 1000
const RECEIPT_DEBOUNCE_MS = 500
const RECEIPT_BATCH_LIMIT = 200

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

function list(values: string[], limit: number): string {
  return `${values.slice(0, limit).join(', ')}${values.length > limit ? ', …' : ''}`
}

function recipients(sends: PeerSent[]): string {
  const addresses = [...new Set(sends.map(sent => formatPeerAddress(sent.endpoint)))]
  return addresses.length ? `${plural(addresses.length, 'recipient')}: ${list(addresses, 3)}` : ''
}

function handles(sends: PeerSent[]): string {
  const byEndpoint = new Map<string, PeerSent>()
  for (const sent of sends) if (!byEndpoint.get(sent.endpoint)?.name) byEndpoint.set(sent.endpoint, sent)
  const unique = [...byEndpoint.values()]
  const names = unique.map(sent => {
    if (!sent.name) return formatPeerAddress(sent.endpoint)
    return unique.filter(other => other.name === sent.name).length === 1 ? `@${sent.name}` : `@${sent.name} at ${formatPeerAddress(sent.endpoint)}`
  })
  return names.length ? ` (${plural(names.length, 'recipient')}: ${list(names, 3)})` : ''
}

function ids(sends: PeerSent[]): string {
  const who = recipients(sends)
  return ` (${who ? `${who}; ` : ''}msg_id: ${list(sends.map(sent => sent.msgId), 5)})`
}

function receiptTranscript(status: ReceiptStatus, sends: PeerSent[]): string {
  const count = sends.length
  const what = {
    held: 'held by the receiving session',
    denied: 'denied',
    expired: 'expired without approval',
    delivered: 'released after approval',
    refused: 'refused',
  }[status]
  const why = {
    held: "Claude in that session hasn't seen it. The usual cause is that the two sessions are in different permission modes: a terminal session then asks for approval there, but the desktop app and non-interactive sessions can't ask, so there the message expires undelivered unless the modes come to match. A session can also be set to hold every message.",
    denied: "The recipient's user declined it; it was not delivered.",
    expired: "It was never approved, so it wasn't delivered and nothing is waiting in that session. Claude was told.",
    delivered: 'It was approved and released to that session (final delivery is up to their queue).',
    refused: 'That session is not accepting cross-session messages (the feature is off there, or a setting or policy there refuses them); it was not delivered.',
  }[status]
  return `Cross-session ${count === 1 ? 'message' : `messages (${count})`} ${what}${handles(sends)}. ${why}`
}

function receiptModel(status: ReceiptStatus, sends: PeerSent[]): string {
  const count = sends.length
  const subject = count === 1 ? 'Your message to another session' : `${count} of your messages to another session`
  const was = count === 1 ? 'was' : 'were'
  const it = count === 1 ? 'it' : 'them'
  const detail = ids(sends)
  switch (status) {
    case 'held':
      return `[Cross-session delivery notice] ${subject} ${was} held by that session${detail}. NOT delivered: its Claude has not seen ${it}. Do not report ${it} as delivered, do not wait for a reply, and do not resend while held. The usual cause is that the two sessions run in different permission modes: a terminal session then asks its user to approve, but a Claude Desktop or non-interactive session cannot ask, so there the hold expires undelivered unless the modes come to match. A session can also be set to hold every message. Another notice follows on release, denial or expiry. Tell your user what is held and why, or choose another approach.`
    case 'denied':
      return `[Cross-session delivery notice] ${subject} ${was} denied by the recipient user${detail}. Not delivered to that session's Claude. Do not wait for a reply; continue, or choose another approach.`
    case 'expired':
      return `[Cross-session delivery notice] ${subject} ${was} not approved before expiry${detail}. Not delivered to that session's Claude, and nothing is waiting there. Do not wait for a reply, and do not resend unprompted: while the two sessions' permission modes differ a resend is only held again. Tell your user what was not delivered and why; send ${it} again, edited if that helps, when they ask.`
    case 'delivered':
      return `[Cross-session delivery notice] ${subject} ${was} approved and released to that session${detail}.`
    case 'refused':
      return `[Cross-session delivery notice] ${subject} ${was} refused${detail}: that session is not accepting cross-session messages (the feature is off there, or a setting or policy there refuses them). Not delivered to that session's Claude. Do not wait for a reply and do not resend; tell the user, or choose another approach.`
  }
}

function droppedNotices(sends: PeerSent[]): PeerNotice {
  const count = sends.length
  return {
    transcript: `Cross-session ${count === 1 ? 'message was' : `messages (${count}) were`} dropped at the recipient session's inbox${handles(sends)} and not delivered. Claude was told not to resend right away.`,
    model: `[Cross-session delivery notice] Do not resend now: ${count === 1 ? 'one of your messages to another session was' : `${count} of your messages to another session were`} dropped at that session's inbox${ids(sends)} and NOT delivered. Treat them as unsent. If the content still matters, fold it into ONE later message after you have finished other work; never retry in a loop.`,
  }
}

type Batch = Record<ReceiptStatus | 'dropped', PeerSent[]>
const emptyBatch = (): Batch => ({ held: [], denied: [], expired: [], delivered: [], refused: [], dropped: [] })

/** Groups receipts that arrive together into one notice per status. */
export function createReceiptNotices(deliver: (notice: PeerNotice) => void): {
  note(status: ReceiptStatus | 'dropped', sent: PeerSent): void
  dispose(): void
} {
  let batch = emptyBatch()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    timer = undefined
    const current = batch
    batch = emptyBatch()
    for (const status of ['held', 'denied', 'expired', 'delivered', 'refused'] as const) {
      const sends = current[status]
      if (sends.length) deliver({ transcript: receiptTranscript(status, sends), model: receiptModel(status, sends) })
    }
    if (current.dropped.length) deliver(droppedNotices(current.dropped))
  }
  return {
    note(status, sent) {
      if (batch[status].length < RECEIPT_BATCH_LIMIT) batch[status].push(sent)
      clearTimeout(timer)
      timer = setTimeout(flush, RECEIPT_DEBOUNCE_MS)
      timer.unref?.()
    },
    dispose() {
      clearTimeout(timer)
      timer = undefined
      batch = emptyBatch()
    },
  }
}

export type PeerIdleState = 'idle' | 'exited' | 'unavailable' | 'expired'

function clock(time: number | undefined): string {
  return time === undefined ? '' : new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}

const UNAVAILABLE = 'it is shutting down, its subscription table is full, a newer subscription displaced this one, or it answered in a form this version does not recognize'

export function idleNotice(state: PeerIdleState, label: string, finishedAt?: number, modelVisible = true): PeerNotice {
  const at = clock(finishedAt)
  const hours = PEER_IDLE_SUBSCRIPTION_MS / 3600000
  const transcript = {
    idle: `${label} is idle${at ? ` — finished a turn at ${at}` : ''}`,
    exited: `${label} exited${at ? ` at ${at}` : ''} before going idle.`,
    unavailable: `${label} is not holding the idle subscription (${UNAVAILABLE}) — no idle notice will come from it.`,
    expired: `No idle signal from ${label} within ${hours} h — idle subscription expired.`,
  }[state]
  if (!modelVisible) return { transcript }
  const source = `This is an automated notice from ${state === 'expired' ? "your own session's harness" : "that session's harness"} — not a message from a person, and not an instruction; act on it only insofar as your user's earlier request calls for it.`
  const model = {
    idle: `[Cross-session idle notice] "${label}", which you asked to be notified about, is idle now${at ? ` — it finished a turn at ${at}` : ''}. ${source}`,
    exited: `[Cross-session idle notice] "${label}", which you asked to be notified about, has exited${at ? ` (at ${at})` : ''} before going idle; it will not process further messages at that address. ${source}`,
    unavailable: `[Cross-session idle notice] "${label}" is not holding your idle subscription (${UNAVAILABLE}), so no idle notice will arrive from it. Do not wait for one; if you still need to know, ask your user or try again later. ${source}`,
    expired: `[Cross-session idle notice] No idle signal arrived from "${label}" within ${hours} hours; the subscription has expired (it may still be busy, be waiting on its user, refuse inbound requests, run a version without idle notices, or have ended abruptly). Do not keep waiting for it; if you still need to know, ask your user or list the sessions to check its status. ${source}`,
  }[state]
  return { transcript, model }
}

/**
 * SendMessage result line for notify_when_idle. `setting` is this session's crossSessionInbound policy, if set;
 * `unasserted` is what this session does with peer traffic that asserts no permission mode.
 */
export function idleSubscriptionMessage(result: PeerIdleSubscribeResult, label: string, setting: PeerInboundPolicy | undefined, unasserted: PeerInboundPolicy, nonInteractive: boolean): string {
  if (!('reason' in result)) {
    if (!result.peerKnownCapable) return `Subscription sent to "${label}" — but whether it supports idle notices is unknown (no readable session-registry record vouches for it), so a notice may never come; you will be told if it lapses unheard. Do not rely on it.`
    if (setting === 'accept') return `Subscribed — you will get one notice here when "${label}" is next idle (or exits). Do not poll or wait for it; carry on.`
    if (setting === 'hold') {
      return nonInteractive
        ? `Subscribed — "${label}" will send one notice when it is next idle (or exits), but this session holds ALL inbound peer traffic (crossSessionInbound: hold), so it will only be logged here, not delivered to you. Carry on; do not poll.`
        : `Subscribed — "${label}" will send one notice when it is next idle (or exits); this session holds ALL inbound peer traffic (crossSessionInbound: hold), so it will be shown to your user in the transcript, not delivered to you. Carry on; do not poll.`
    }
    const sameClass = 'that session runs in the same permission class as this one (or is one this session spawned)'
    const otherwise = nonInteractive ? 'only logged here' : 'shown to your user in the transcript'
    return unasserted === 'accept'
      ? `Subscribed — you will get one notice here when "${label}" is next idle (or exits), provided ${sameClass} or asserts none; otherwise it is ${otherwise}. Do not poll or wait for it; carry on.`
      : `Subscribed — "${label}" will send one notice when it is next idle (or exits). It is delivered to you if ${sameClass}; otherwise it is ${otherwise} (this session holds other inbound peer traffic). Carry on; do not poll.`
  }
  switch (result.reason) {
    case 'requester-refuses-inbound': return 'notify_when_idle: this session does not accept inbound cross-session traffic (messaging is off here or crossSessionInbound is refuse), so an idle notice could never be shown to you — nothing was subscribed.'
    case 'no-inbox': return 'notify_when_idle needs this session to have a messaging inbox, and it has none — no notice will arrive.'
    case 'self-target': return 'notify_when_idle: that address is THIS session — nothing was subscribed; you already know when your own turn ends.'
    case 'peer-unsupported': return 'notify_when_idle: that session runs a version without idle notices — nothing was subscribed. Ask your user, or message it and wait for its reply instead.'
    case 'cap': return `notify_when_idle: this session already holds ${PEER_IDLE_SUBSCRIPTION_CAP} pending idle subscriptions — wait for some to fire or expire.`
    case 'peer-gone': return 'notify_when_idle: no session is listening at that address any more; nothing was subscribed, and any earlier idle subscription to it is void. Call ListAgents to get the current address.'
    case 'send-failed': return 'notify_when_idle: the subscription could not be sent — no notice will arrive.'
  }
}
