import { mkdirSync } from 'fs'
import { join } from 'path'
import { DangerousBackend } from '../server/backends/dangerousBackend.js'
import {
  probeRunningServer,
  removeServerLock,
  writeServerLock,
} from '../server/lockfile.js'
import { createServerLogger } from '../server/serverLog.js'
import { SessionManager } from '../server/sessionManager.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { shouldRejectRootBypassPermissions } from '../setup.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { createWebSecrets } from './auth.js'
import { startWebServer, type WebAsset } from './webServer.js'

const LOCK_NAME = 'web.lock'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
// Only what a browser launcher needs; API keys and tokens stay out of it.
const BROWSER_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'BROWSER',
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
]

export type WebCommandOptions = {
  port: string
  host: string
  workspace?: string
  open: boolean
  idleTimeout: string
  maxSessions: string
}

function browserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of BROWSER_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

async function openInBrowser(url: string): Promise<void> {
  const env = browserEnv()
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url,OpenURL', url]]
      : [
          process.env.BROWSER ||
            (process.platform === 'darwin' ? 'open' : 'xdg-open'),
          [url],
        ]
  const { code } = await execFileNoThrowWithCwd(command, args, {
    env,
    extendEnv: false,
    timeout: 10_000,
  })
  if (code !== 0) {
    process.stderr.write('Could not open a browser; open the URL above.\n')
  }
}

function fail(message: string): never {
  process.stderr.write(message + '\n')
  process.exit(1)
}

export async function runWebCommand(opts: WebCommandOptions): Promise<void> {
  if (typeof Bun === 'undefined') {
    fail(
      'claude web requires the Bun runtime; run it from the packaged claude binary.',
    )
  }
  if (!LOOPBACK_HOSTS.has(opts.host)) {
    fail(`--host must be a loopback address (127.0.0.1, ::1 or localhost).`)
  }
  const port = Number(opts.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`Invalid --port: ${opts.port}`)
  }
  const shouldOpen =
    opts.open && !process.env.SSH_CONNECTION && !process.env.SSH_TTY

  const existing = await probeRunningServer(LOCK_NAME)
  if (existing) {
    process.stdout.write(
      `claude web is already running (pid ${existing.pid}) at ${existing.httpUrl}\n`,
    )
    if (shouldOpen) await openInBrowser(existing.httpUrl)
    process.exit(0)
  }

  let assets: Map<string, WebAsset>
  try {
    assets = (await import('./assets.js')).loadWebAssets()
  } catch {
    fail(
      'The web UI is not built into this binary. From a source checkout run `bun run build:web` first.',
    )
  }

  const workspace =
    opts.workspace ?? join(getClaudeConfigHomeDir(), 'web', 'workspace')
  mkdirSync(workspace, { recursive: true })
  const uploadsDir = join(getClaudeConfigHomeDir(), 'web', 'uploads')
  mkdirSync(uploadsDir, { recursive: true })

  const logger = createServerLogger()
  const sessionManager = new SessionManager(
    new DangerousBackend({
      includePartialMessages: true,
      // Root sessions refuse the flag at startup, so only offer it elsewhere.
      allowBypassPermissions: !shouldRejectRootBypassPermissions(),
      // Uploaded files are referenced by path; Read them without a prompt.
      addDirs: [uploadsDir],
      // Teammate messages to the lead reach the page only as replayed prompts.
      replayUserMessages: true,
    }),
    {
      idleTimeoutMs: Number(opts.idleTimeout),
      maxSessions: Number(opts.maxSessions),
      logger,
      replayTasks: true,
    },
  )
  const { token, cookieKey } = createWebSecrets()
  const server = startWebServer(
    { host: opts.host, port, token, cookieKey, workspace, uploadsDir },
    sessionManager,
    assets,
    logger,
  )

  const urlHost = opts.host === '::1' ? '[::1]' : opts.host
  const baseUrl = `http://${urlHost}:${server.port}/`
  await writeServerLock(
    {
      pid: process.pid,
      port: server.port,
      host: opts.host,
      httpUrl: baseUrl,
      startedAt: Date.now(),
    },
    LOCK_NAME,
  )
  const signInUrl = `${baseUrl}?token=${token}`
  process.stdout.write(
    [
      `Claude web UI: ${signInUrl}`,
      `Sessions start in ${workspace} and run with your local credentials and full access to this machine. Press Ctrl+C to stop.`,
      '',
    ].join('\n'),
  )

  registerCleanup(async () => {
    await removeServerLock(LOCK_NAME)
    server.stop(true)
    await sessionManager.destroyAll()
  })

  if (shouldOpen) await openInBrowser(signInUrl)
}
