import { createHash } from 'crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { getOpenAIAuthInfo } from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

export type CodexAppAuthReason =
  | 'missing_link'
  | 'reauthentication_required'
  | 'oauth_upgrade_required'
  | 'unknown'

export type CodexAppRuntimeStatus =
  | { kind: 'unchecked' }
  | { kind: 'checking'; startedAt: number }
  | { kind: 'ready'; checkedAt: number }
  | {
      kind: 'needs-auth'
      authReason: CodexAppAuthReason
      checkedAt: number
    }
  | { kind: 'error'; checkedAt: number }
  | { kind: 'cancelled'; checkedAt: number }

type ConnectorAuthFailure = {
  authReason: CodexAppAuthReason
}

const uncheckedStatus: CodexAppRuntimeStatus = Object.freeze({
  kind: 'unchecked',
})
const statuses = new Map<string, CodexAppRuntimeStatus>()
const listeners = new Set<() => void>()
let revision = 0
let persistenceStarted = false

const STATUS_CACHE_VERSION = 1
const STATUS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CHECKING_CACHE_TTL_MS = 5 * 60 * 1000

type PersistedStatus = Exclude<CodexAppRuntimeStatus, { kind: 'unchecked' }>
type StatusCacheFile = {
  version: typeof STATUS_CACHE_VERSION
  accounts: Record<string, Record<string, PersistedStatus>>
}

function statusCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'codex-app-status-v1.json')
}

function currentAccountKey(): string {
  const auth = getOpenAIAuthInfo()
  if (!auth?.isChatGPT) return 'no-chatgpt-oauth'
  const identity =
    auth.accountId?.trim() || auth.email?.trim() || 'chatgpt-oauth'
  return createHash('sha256').update(identity).digest('hex')
}

function statusKey(connectorId: string): string {
  return `${currentAccountKey()}\0${connectorId.trim()}`
}

function statusTimestamp(status: PersistedStatus): number {
  return status.kind === 'checking' ? status.startedAt : status.checkedAt
}

function isPersistedStatus(value: unknown): value is PersistedStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const status = value as Record<string, unknown>
  if (status.kind === 'checking') return typeof status.startedAt === 'number'
  if (
    status.kind === 'ready' ||
    status.kind === 'error' ||
    status.kind === 'cancelled'
  ) {
    return typeof status.checkedAt === 'number'
  }
  return (
    status.kind === 'needs-auth' &&
    typeof status.checkedAt === 'number' &&
    (status.authReason === 'missing_link' ||
      status.authReason === 'reauthentication_required' ||
      status.authReason === 'oauth_upgrade_required' ||
      status.authReason === 'unknown')
  )
}

function readStatusCache(): StatusCacheFile {
  try {
    const parsed = JSON.parse(readFileSync(statusCachePath(), 'utf-8'))
    if (
      parsed?.version === STATUS_CACHE_VERSION &&
      parsed.accounts &&
      typeof parsed.accounts === 'object' &&
      !Array.isArray(parsed.accounts)
    ) {
      return parsed as StatusCacheFile
    }
  } catch {
    // Missing/corrupt status is equivalent to no prior observation.
  }
  return { version: STATUS_CACHE_VERSION, accounts: {} }
}

function mergePersistedStatuses(): void {
  const accountKey = currentAccountKey()
  if (accountKey === 'no-chatgpt-oauth') return
  const accountStatuses = readStatusCache().accounts[accountKey]
  if (!accountStatuses || typeof accountStatuses !== 'object') return

  const now = Date.now()
  let changed = false
  for (const [connectorId, incoming] of Object.entries(accountStatuses)) {
    if (!connectorId.trim() || !isPersistedStatus(incoming)) continue
    const age = now - statusTimestamp(incoming)
    const ttl =
      incoming.kind === 'checking'
        ? CHECKING_CACHE_TTL_MS
        : STATUS_CACHE_TTL_MS
    if (age < 0 || age > ttl) continue

    const key = statusKey(connectorId)
    const existing = statuses.get(key)
    if (
      existing &&
      existing.kind !== 'unchecked' &&
      statusTimestamp(existing) >= statusTimestamp(incoming)
    ) {
      continue
    }
    statuses.set(key, incoming)
    changed = true
  }
  if (changed) {
    revision += 1
    for (const listener of listeners) listener()
  }
}

function persistStatus(connectorId: string, status: PersistedStatus): void {
  if (process.env.NODE_ENV === 'test') return
  const accountKey = currentAccountKey()
  if (accountKey === 'no-chatgpt-oauth') return

  const file = statusCachePath()
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`
  try {
    const cache = readStatusCache()
    cache.accounts[accountKey] = {
      ...(cache.accounts[accountKey] ?? {}),
      [connectorId]: status,
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, JSON.stringify(cache), {
      encoding: 'utf-8',
      mode: 0o600,
    })
    chmodSync(temporary, 0o600)
    renameSync(temporary, file)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Status persistence is best-effort and must never break tool calls.
    }
  }
}

function ensureStatusPersistence(): void {
  if (persistenceStarted || process.env.NODE_ENV === 'test') return
  persistenceStarted = true
  mergePersistedStatuses()
  const file = statusCachePath()
  watchFile(file, { interval: 500, persistent: false }, (current, previous) => {
    if (current.mtimeMs > previous.mtimeMs) mergePersistedStatuses()
  })
  registerCleanup(async () => {
    unwatchFile(file)
    persistenceStarted = false
  })
}

function publish(
  connectorId: string,
  status: Exclude<CodexAppRuntimeStatus, { kind: 'unchecked' }>,
): void {
  if (!connectorId.trim()) return
  ensureStatusPersistence()
  statuses.set(statusKey(connectorId), status)
  persistStatus(connectorId.trim(), status)
  revision += 1
  for (const listener of listeners) listener()
}

/**
 * Parse only the trusted Codex Apps auth-failure envelope used by upstream
 * Codex. The connector id from the tool definition remains authoritative;
 * result metadata may confirm it, but may not redirect status to another app.
 */
export function parseCodexAppAuthFailure(
  expectedConnectorId: string,
  meta: Record<string, unknown> | undefined,
): ConnectorAuthFailure | undefined {
  const appsMeta = meta?._codex_apps
  if (!appsMeta || typeof appsMeta !== 'object' || Array.isArray(appsMeta)) {
    return undefined
  }
  const failure = (appsMeta as Record<string, unknown>).connector_auth_failure
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
    return undefined
  }
  const fields = failure as Record<string, unknown>
  if (fields.is_auth_failure !== true) return undefined

  const expected = expectedConnectorId.trim()
  if (!expected) return undefined
  if (
    typeof fields.connector_id === 'string' &&
    fields.connector_id.trim() &&
    fields.connector_id.trim() !== expected
  ) {
    return undefined
  }

  const reason = fields.auth_reason
  const authReason: CodexAppAuthReason =
    reason === 'missing_link' ||
    reason === 'reauthentication_required' ||
    reason === 'oauth_upgrade_required'
      ? reason
      : 'unknown'
  return { authReason }
}

export function getCodexAppRuntimeStatus(
  connectorId: string,
): CodexAppRuntimeStatus {
  ensureStatusPersistence()
  return statuses.get(statusKey(connectorId)) ?? uncheckedStatus
}

export function recordCodexAppToolSuccess(connectorId: string): void {
  publish(connectorId, { kind: 'ready', checkedAt: Date.now() })
}

export function shouldTrackCodexAppVerification(
  readOnlyHint: boolean | undefined,
): boolean {
  return readOnlyHint === true
}

export function recordCodexAppToolStarted(connectorId: string): void {
  publish(connectorId, { kind: 'checking', startedAt: Date.now() })
}

export function recordCodexAppToolFailure(
  connectorId: string,
  meta: Record<string, unknown> | undefined,
): void {
  const authFailure = parseCodexAppAuthFailure(connectorId, meta)
  publish(
    connectorId,
    authFailure
      ? {
          kind: 'needs-auth',
          authReason: authFailure.authReason,
          checkedAt: Date.now(),
        }
      : { kind: 'error', checkedAt: Date.now() },
  )
}

export function recordCodexAppToolCancelled(connectorId: string): void {
  publish(connectorId, { kind: 'cancelled', checkedAt: Date.now() })
}

export function subscribeCodexAppStatuses(listener: () => void): () => void {
  ensureStatusPersistence()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCodexAppStatusesRevision(): number {
  return revision
}

export function codexAppAuthorizationLabel(
  status: CodexAppRuntimeStatus,
): string {
  if (status.kind === 'unchecked') return 'Not yet verified (checked on use)'
  if (status.kind === 'checking') return 'Checking now'
  if (status.kind === 'ready') {
    return 'Verified by last successful read-only call'
  }
  if (status.kind === 'error') return 'Unknown (last call failed)'
  if (status.kind === 'cancelled') return 'Not verified (last call cancelled)'
  switch (status.authReason) {
    case 'missing_link':
      return 'Sign-in required'
    case 'reauthentication_required':
      return 'Re-authentication required'
    case 'oauth_upgrade_required':
      return 'Reconnect to grant additional permissions'
    default:
      return 'Authentication required'
  }
}

export function codexAppUsabilityLabel(
  status: CodexAppRuntimeStatus,
  enabled: boolean,
): string {
  if (!enabled) return 'Disabled locally'
  switch (status.kind) {
    case 'ready':
      return 'Ready (read access verified)'
    case 'checking':
      return 'Checking now'
    case 'needs-auth':
      return 'Needs authentication'
    case 'error':
      return 'Last tool call failed'
    case 'cancelled':
      return 'Last tool call cancelled'
    default:
      return 'Not yet verified (checked on use)'
  }
}

export function codexAppListStatusLabel(
  status: CodexAppRuntimeStatus,
  enabled: boolean,
): string {
  if (status.kind === 'ready') {
    return enabled ? 'ready' : 'last call succeeded'
  }
  if (status.kind === 'checking') return 'checking now'
  if (status.kind === 'needs-auth') return 'needs authentication'
  if (status.kind === 'error') return 'last tool call failed'
  if (status.kind === 'cancelled') return 'last call cancelled'
  return 'not yet verified'
}

/** @internal */
export function resetCodexAppStatusesForTesting(): void {
  if (persistenceStarted) {
    unwatchFile(statusCachePath())
    persistenceStarted = false
  }
  statuses.clear()
  revision = 0
  listeners.clear()
}
