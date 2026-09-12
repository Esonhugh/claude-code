import { createHash } from 'crypto'
import { isAbsolute, resolve } from 'path'
import type { SettingSource } from './settings/constants.js'

export type PeerPermissionClass = 'bypass' | 'prompting'
export type PeerInboundPolicy = 'accept' | 'hold' | 'refuse'
export type PeerMessageStatus = 'held' | 'denied' | 'expired' | 'delivered' | 'refused' | 'dropped'
export type PeerMessageMetadata = {
  from?: string
  fromSession?: string
  hopChain?: string[]
  fromName?: string
  fromMode?: PeerPermissionClass
}

export const PEER_MAX_FRAME_BYTES = 1024 * 1024
export const PEER_TIMEOUT_MS = 5000
export const PEER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const addressChars = 'A-Za-z0-9%:_/.\\\\-'
const sessionPattern = '[A-Za-z0-9_-]{1,80}'
const hopPattern = '[0-9a-f]{24}(?:,[0-9a-f]{24}){0,31}'
const wrapperPattern = new RegExp(`^<cross-session-message(?: from="([${addressChars}]+)")?(?: from-session="(${sessionPattern})")?(?: hop-chain="(${hopPattern})")?(?: from-name="([^"<>\\n\\r]+)")?(?: from-mode="(bypass|prompting)")?>\\n([\\s\\S]*)\\n</cross-session-message>$`)

// Match the official closing-tag escape, including invisible separators and
// bracket/slash lookalikes. Escaped '<\\' is intentionally left unchanged.
const invisible = '\\u00ad\\u034f\\u0600-\\u0605\\u061c\\u06dd\\u070f\\u0890\\u0891\\u08e2\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u{110bd}\\u{110cd}\\u{13430}-\\u{1343f}\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}'
const marks = '\\u0300-\\u0344\\u0346-\\u036f\\u0483-\\u0489\\u0591-\\u05bd\\u05bf\\u05c1\\u05c2\\u05c4\\u05c5\\u05c7\\u0610-\\u061a\\u064b-\\u065f\\u0670\\u06d6-\\u06dc\\u06df-\\u06e4\\u06e7\\u06e8\\u06ea-\\u06ed\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\u3099\\u309a\\ufe20-\\ufe2f'
const separators = `[${invisible}${marks}\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f\\u2028\\u2029]*`
const opening = '<\uFF1C\uFE64\u2329\u27E8\u3008\u2039\u02C2\u1438\u276C\u276E\u2770\u29FC\u226E\u227A\u22D6'
const closing = '>\uFF1E\uFE65\u232A\u27E9\u3009\u203A\u02C3\u1433\u276D\u276F\u2771\u29FD\u226F\u227B\u22D7'
const filler = `[^A-Za-z0-9_\\-${opening}${closing}]*`
// Each combining mark is an individual separator, not a composed character.
// eslint-disable-next-line no-misleading-character-class
const closingTag = new RegExp(`[${opening}](?!\\\\)(?=${filler}[/\uFF0F\u2215\u2044]${filler}${[...'cross-session-message'].join(separators)}(?:[^A-Za-z0-9_\\-]|$))`, 'giu')

export function cleanPeerName(name: string): string {
  const cleaned = name.replace(/["<>\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, '').trim()
  const chars = [...cleaned]
  return chars.length > 64 ? `${chars.slice(0, 64).join('')}…` : cleaned
}

export function formatPeerAddress(endpoint: string): string {
  return `uds:${endpoint.replace(/[^A-Za-z0-9:_/.\\-]/gu, char =>
    [...Buffer.from(char)].map(byte => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  )}`
}

export function canonicalPeerEndpoint(endpoint: string): string {
  const pipe = /^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i.exec(endpoint)
  if (pipe && pipe[2] !== '.' && pipe[2] !== '..' && !/[. ]$/.test(pipe[2]!)) {
    return `\\\\.\\pipe\\${pipe[1] ? 'local\\' : ''}${pipe[2]!.toLowerCase()}`
  }
  if (!isAbsolute(endpoint) || endpoint.startsWith('//') || endpoint.includes('\0') || !endpoint.endsWith('.sock')) {
    throw new Error('Expected an absolute local .sock path or local named pipe')
  }
  return resolve(endpoint)
}

export function peerKeyFilename(pid: number, endpoint: string): string {
  return `${pid}.${createHash('sha256').update(canonicalPeerEndpoint(endpoint)).digest('hex')}.key`
}

export function peerRef(endpoint: string): string {
  return createHash('sha256').update(`session:${endpoint}`).digest('hex').slice(0, 12)
}

export function formatPeerMessage(body: string, metadata: PeerMessageMetadata): string {
  const attrs: string[] = []
  if (metadata.from) {
    if (!new RegExp(`^[${addressChars}]+$`).test(metadata.from)) throw new Error('Invalid peer address')
    attrs.push(`from="${metadata.from}"`)
  }
  if (metadata.fromSession && new RegExp(`^${sessionPattern}$`).test(metadata.fromSession)) attrs.push(`from-session="${metadata.fromSession}"`)
  const hops = metadata.hopChain?.join(',')
  if (hops && new RegExp(`^${hopPattern}$`).test(hops)) attrs.push(`hop-chain="${hops}"`)
  const name = metadata.fromName && cleanPeerName(metadata.fromName)
  if (name) attrs.push(`from-name="${name}"`)
  if (metadata.fromMode) attrs.push(`from-mode="${metadata.fromMode}"`)
  return `<cross-session-message${attrs.length ? ` ${attrs.join(' ')}` : ''}>\n${body.replace(closingTag, '<\\')}\n</cross-session-message>`
}

export function parsePeerMessage(content: string): (PeerMessageMetadata & { body: string }) | undefined {
  const match = wrapperPattern.exec(content)
  if (!match) return
  const result = {
    ...(match[1] !== undefined && { from: match[1] }),
    ...(match[2] !== undefined && { fromSession: match[2] }),
    ...(match[3] !== undefined && { hopChain: match[3].split(',') }),
    ...(match[4] !== undefined && { fromName: match[4] }),
    ...(match[5] !== undefined && { fromMode: match[5] as PeerPermissionClass }),
    body: match[6]!,
  }
  return formatPeerMessage(result.body, result) === content ? result : undefined
}

export function resolveInboundPolicy(
  sources: Partial<Record<SettingSource, PeerInboundPolicy>>,
  receiver: PeerPermissionClass | undefined,
  sender?: PeerPermissionClass,
): PeerInboundPolicy {
  const rank = { accept: 0, hold: 1, refuse: 2 }
  let policy = sources.policySettings ?? sources.flagSettings ?? sources.userSettings
  for (const repo of [sources.localSettings, sources.projectSettings]) {
    if (repo && rank[repo] > rank[policy ?? 'accept']) policy = repo
  }
  if (policy) return policy
  if (!receiver) return 'hold'
  return sender ? (sender === receiver ? 'accept' : 'hold') : receiver === 'bypass' ? 'hold' : 'accept'
}
