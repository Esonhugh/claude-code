import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  onSessionSwitch,
} from '../bootstrap/state.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, isFsInaccessible } from './errors.js'
import { getProcessStart, isProcessRunning } from './genericProcessUtils.js'
import { cleanPeerName } from './peerProtocol.js'
import { getPlatform } from './platform.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { getAgentId } from './teammate.js'
import { getUdsMessagingSocketPath } from './udsMessaging.js'

export type SessionKind = 'interactive' | 'bg' | 'daemon' | 'daemon-worker'
export type SessionStatus = 'busy' | 'idle' | 'waiting'

let registeredName: string | undefined
let pidFileWriteChain: Promise<void> = Promise.resolve()
let unregistering = false

export function getRegisteredSessionName(): string | undefined {
  return registeredName
}

function getSessionsDir(): string {
  return join(getClaudeConfigHomeDir(), 'sessions')
}

/**
 * Kind override from env. Set by the spawner (`claude --bg`, daemon
 * supervisor) so the child can register without the parent having to
 * write the file for it — cleanup-on-exit wiring then works for free.
 * Gated so the env-var string is DCE'd from external builds.
 */
function envSessionKind(): SessionKind | undefined {
  if (feature('BG_SESSIONS')) {
    const k = process.env.CLAUDE_CODE_SESSION_KIND
    if (k === 'bg' || k === 'daemon' || k === 'daemon-worker') return k
  }
  return undefined
}

/**
 * True when this REPL is running inside a `claude --bg` tmux session.
 * Exit paths (/exit, ctrl+c, ctrl+d) should detach the attached client
 * instead of killing the process.
 */
export function isBgSession(): boolean {
  return envSessionKind() === 'bg'
}

/**
 * Write a PID file for this session and register cleanup.
 *
 * Registers all top-level sessions — interactive CLI, SDK (vscode, desktop,
 * typescript, python, -p), bg/daemon spawns — so `claude ps` sees everything
 * the user might be running. Skips only teammates/subagents, which would
 * conflate swarm usage with genuine concurrency and pollute ps with noise.
 *
 * Returns true if registered, false if skipped.
 * Errors logged to debug, never thrown.
 */
export async function registerSession(): Promise<boolean> {
  if (getAgentId() != null) return false

  const kind: SessionKind = envSessionKind() ?? 'interactive'
  const dir = getSessionsDir()
  const pidFile = join(dir, `${process.pid}.json`)
  unregistering = false
  registeredName = cleanPeerName(process.env.CLAUDE_CODE_SESSION_NAME || basename(getOriginalCwd())) || `claude-${process.pid}`

  let unsubscribeSession: (() => void) | undefined
  const unregisterCleanup = registerCleanup(async () => {
    unregistering = true
    unsubscribeSession?.()
    await pidFileWriteChain
    await unlink(pidFile).catch(() => {})
    registeredName = undefined
    unregisterCleanup()
  })

  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    const messagingSocketPath = getUdsMessagingSocketPath()
    const temp = `${pidFile}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(temp, jsonStringify({
        pid: process.pid,
        sessionId: getSessionId(),
        cwd: getOriginalCwd(),
        startedAt: Date.now(),
        procStart: await getProcessStart(process.pid),
        pidDomain: process.platform,
        version: MACRO.VERSION,
        kind,
        name: registeredName,
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
        ...(messagingSocketPath ? { messagingSocketPath, peerProtocol: 1, peerFeatures: [] } : {}),
        ...(feature('BG_SESSIONS')
          ? {
              logPath: process.env.CLAUDE_CODE_SESSION_LOG,
              agent: process.env.CLAUDE_CODE_AGENT,
            }
          : {}),
      }), { mode: 0o600, flag: 'wx' })
      await rename(temp, pidFile)
    } finally {
      await unlink(temp).catch(() => {})
    }
    // --resume / /resume mutates getSessionId() via switchSession. Without
    // this, the PID file's sessionId goes stale and `claude ps` sparkline
    // reads the wrong transcript.
    unsubscribeSession = onSessionSwitch(id => {
      void updatePidFile({ sessionId: id })
    })
    return true
  } catch (e) {
    unregisterCleanup()
    registeredName = undefined
    logForDebugging(`[concurrentSessions] register failed: ${errorMessage(e)}`)
    return false
  }
}

// Serialize read/modify/rename so concurrent name, activity and resume updates
// cannot lose fields or expose partially written JSON to another process.
async function updatePidFile(patch: Record<string, unknown>): Promise<void> {
  if (unregistering) return
  const pidFile = join(getSessionsDir(), `${process.pid}.json`)
  pidFileWriteChain = pidFileWriteChain.then(async () => {
    const temp = `${pidFile}.${randomBytes(8).toString('hex')}.tmp`
    try {
      const data = jsonParse(await readFile(pidFile, 'utf8')) as Record<string, unknown>
      await writeFile(temp, jsonStringify({ ...data, ...patch }), { mode: 0o600, flag: 'wx' })
      await rename(temp, pidFile)
    } catch (e) {
      logForDebugging(`[concurrentSessions] updatePidFile failed: ${errorMessage(e)}`)
    } finally {
      await unlink(temp).catch(() => {})
    }
  })
  await pidFileWriteChain
}

export async function updateSessionName(
  name: string | undefined,
): Promise<void> {
  if (!name) return
  const cleaned = cleanPeerName(name)
  if (!cleaned) return
  registeredName = cleaned
  await updatePidFile({ name: cleaned })
}

/**
 * Record this session's Remote Control session ID so peer enumeration can
 * dedup: a session reachable over both UDS and bridge should only appear
 * once (local wins). Cleared on bridge teardown so stale IDs don't
 * suppress a legitimately-remote session after reconnect.
 */
export async function updateSessionBridgeId(
  bridgeSessionId: string | null,
): Promise<void> {
  await updatePidFile({ bridgeSessionId })
}

/**
 * Push live activity state for `claude ps`. Fire-and-forget from REPL's
 * status-change effect — a dropped write just means ps falls back to
 * transcript-tail derivation for one refresh.
 */
export async function updateSessionActivity(patch: {
  status?: SessionStatus
  waitingFor?: string
}): Promise<void> {
  await updatePidFile({ ...patch, updatedAt: Date.now() })
}

/**
 * Count live concurrent CLI sessions (including this one).
 * Filters out stale PID files (crashed sessions) and deletes them.
 * Returns 0 on any error (conservative).
 */
export async function countConcurrentSessions(): Promise<number> {
  const dir = getSessionsDir()
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (e) {
    if (!isFsInaccessible(e)) {
      logForDebugging(`[concurrentSessions] readdir failed: ${errorMessage(e)}`)
    }
    return 0
  }

  let count = 0
  for (const file of files) {
    // Strict filename guard: only `<pid>.json` is a candidate. parseInt's
    // lenient prefix-parsing means `2026-03-14_notes.md` would otherwise
    // parse as PID 2026 and get swept as stale — silent user data loss.
    // See anthropics/claude-code#34210.
    if (!/^\d+\.json$/.test(file)) continue
    const pid = parseInt(file.slice(0, -5), 10)
    if (pid === process.pid) {
      count++
      continue
    }
    if (isProcessRunning(pid)) {
      count++
    } else if (getPlatform() !== 'wsl') {
      // Stale file from a crashed session — sweep it. Skip on WSL: if
      // ~/.claude/sessions/ is shared with Windows-native Claude (symlink
      // or CLAUDE_CONFIG_DIR), a Windows PID won't be probeable from WSL
      // and we'd falsely delete a live session's file. This is just
      // telemetry so conservative undercount is acceptable.
      void unlink(join(dir, file)).catch(() => {})
    }
  }
  return count
}
