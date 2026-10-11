import type { ProgramStatus } from '../ink/termio/osc.js'

export type ProgramTurnEnd = null | 'completed' | 'stopped' | { errorKind?: string; failure: string }
export type ProgramBlockedOn = 'permission prompt' | 'sandbox request' | 'worker request' | 'goal proposal' | 'input needed' | 'dialog open'
export type ProgramStatusInput = {
  busy: boolean
  queued: boolean
  blockedOn?: ProgramBlockedOn
  lastTurnEnd: ProgramTurnEnd
  signedInSinceLastTurn: boolean
}

const BLOCKED_KIND = {
  'permission prompt': 'permission',
  'sandbox request': 'permission',
  'worker request': 'permission',
  'goal proposal': 'permission',
  'input needed': 'question',
  'dialog open': undefined,
} as const
const AUTH_ERROR_KINDS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error'])

/** Official 2.1.296: busy, waiting, then the previous turn's retained outcome. */
export function selectProgramStatus(input: ProgramStatusInput): ProgramStatus {
  if (input.busy || (input.queued && input.blockedOn === undefined)) return { state: 'working' }
  if (input.blockedOn !== undefined) {
    const kind = BLOCKED_KIND[input.blockedOn]
    return { state: 'blocked', ...(kind ? { kind } : {}) }
  }
  const end = input.lastTurnEnd
  if (end === 'completed') return { state: 'done' }
  if (end === null || end === 'stopped') return { state: 'idle' }
  if (end.errorKind === undefined || !AUTH_ERROR_KINDS.has(end.errorKind)) return { state: 'error', msg: end.failure }
  return input.signedInSinceLastTurn ? { state: 'idle' } : { state: 'blocked', kind: 'auth', msg: end.failure }
}

export function programTurnEnd(
  aborted: boolean,
  last?: { type: string; isApiErrorMessage?: boolean; error?: unknown },
  failure = '',
): ProgramTurnEnd {
  if (aborted) return 'stopped'
  if (last?.type === 'assistant' && last.isApiErrorMessage) return { errorKind: typeof last.error === 'string' ? last.error : undefined, failure: programStatusFailure(failure) }
  return 'completed'
}

/** Bridge this build's SDK JSON envelope to the official terminal failure text. */
function programStatusFailure(failure: string): string {
  const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(Boolean)
  const line = firstLine(failure) ?? 'Turn failed'
  const envelope = /^(API Error: \d+ )(\{.*\})$/.exec(line)
  if (!envelope) return line
  try {
    const body: unknown = JSON.parse(envelope[2]!)
    if (body && typeof body === 'object' && 'error' in body) {
      const error = body.error
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
        return firstLine(envelope[1] + error.message) ?? line
      }
    }
  } catch {
    // Non-JSON provider errors retain their original first line.
  }
  return line
}
