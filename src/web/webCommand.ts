import { accessSync, constants, mkdirSync } from 'fs'
import { join } from 'path'
import { setCwdState, setOriginalCwd, setProjectRoot } from '../bootstrap/state.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { initBuiltinPlugins } from '../plugins/bundled/index.js'
import { initBundledSkills } from '../skills/bundled/index.js'
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
import { fetchBootstrapData } from '../services/api/bootstrap.js'
import { createWebSecrets } from './auth.js'
import { lanInterfaceAddresses, resolveBindHost } from './network.js'
import {
  parsePreviewOrigin,
  startWebServer,
  type WebAsset,
} from './webServer.js'

const LOCK_NAME = 'web.lock'
// A Host header value: a DNS name or bracketed IPv6 address, optional port.
const TRUSTED_HOST = /^([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(:\d{1,5})?$/i
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

// Commander fills the defaults; its typings still mark them optional.
export type WebCommandOptions = {
  port?: string
  host?: string
  workspace?: string
  open: boolean
  idleTimeout?: string
  maxSessions?: string
  dangerouslyAllowLocalNetwork?: boolean
  trustedHost?: string[]
  tlsCert?: string
  tlsKey?: string
  previewOrigin?: string[]
}

function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host
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
  const allowLocalNetwork = opts.dangerouslyAllowLocalNetwork === true
  const bind = resolveBindHost(opts.host, allowLocalNetwork)
  if ('error' in bind) fail(bind.error)
  const trustedHosts = opts.trustedHost ?? []
  for (const host of trustedHosts) {
    if (!TRUSTED_HOST.test(host)) fail(`Invalid --trusted-host: ${host}`)
  }
  const previewOrigins = [
    ...new Set(
      (opts.previewOrigin ?? []).map(
        value =>
          parsePreviewOrigin(value) ??
          fail(
            `Invalid --preview-origin: ${value} (expected an http(s) origin such as http://dev.internal:8080, with no path)`,
          ),
      ),
    ),
  ]
  if (!opts.tlsCert !== !opts.tlsKey) {
    fail('--tls-cert and --tls-key must be given together.')
  }
  const tls =
    opts.tlsCert && opts.tlsKey
      ? { cert: opts.tlsCert, key: opts.tlsKey }
      : undefined
  for (const file of tls ? [tls.cert, tls.key] : []) {
    try {
      accessSync(file, constants.R_OK)
    } catch {
      fail(`Cannot read TLS file: ${file}`)
    }
  }
  const port = Number(opts.port ?? 0)
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
  // The dialogs' project-scope settings (hooks, skills, memory) are the
  // workspace's, where sessions start by default.
  setOriginalCwd(workspace)
  setProjectRoot(workspace)
  setCwdState(workspace)
  resetSettingsCache()
  // The Skills and Mods dialogs list built-in skills and plugins like a session does.
  await initBuiltinPlugins()
  initBundledSkills()
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
      idleTimeoutMs: Number(opts.idleTimeout ?? 600_000),
      maxSessions: Number(opts.maxSessions ?? 8),
      logger,
      replayTasks: true,
    },
  )
  const { token, cookieKey } = createWebSecrets()
  let server: ReturnType<typeof startWebServer>
  try {
    server = startWebServer(
      {
        host: bind.host,
        port,
        token,
        cookieKey,
        workspace,
        uploadsDir,
        trustedHosts,
        allowLocalNetwork,
        tls,
        previewOrigins,
      },
      sessionManager,
      assets,
      logger,
    )
  } catch (err) {
    fail(`Could not start the web server: ${(err as Error).message}`)
  }

  // Sessions snapshot their model list when they start; warming the gateway /
  // bootstrap model caches here gives the first session the discovered models.
  void fetchBootstrapData()

  const scheme = tls ? 'https' : 'http'
  const primaryHost = bind.host === '0.0.0.0' ? '127.0.0.1' : bind.host
  const baseUrl = `${scheme}://${urlHost(primaryHost)}:${server.port}/`
  await writeServerLock(
    {
      pid: process.pid,
      port: server.port,
      host: bind.host,
      httpUrl: baseUrl,
      startedAt: Date.now(),
    },
    LOCK_NAME,
  )
  const signInUrl = `${baseUrl}?token=${token}`
  const lanAddresses =
    bind.host === '0.0.0.0' ? lanInterfaceAddresses() : []
  process.stdout.write(
    [
      `Claude web UI: ${signInUrl}`,
      ...lanAddresses.map(
        address =>
          `  on your network: ${scheme}://${urlHost(address)}:${server.port}/?token=${token}`,
      ),
      `Sessions start in ${workspace} and run with your local credentials and full access to this machine. Press Ctrl+C to stop.`,
      '',
    ].join('\n'),
  )
  if (allowLocalNetwork) {
    process.stderr.write(
      [
        '',
        'WARNING: --dangerously-allow-local-network is on.',
        'Anyone on your local network who gets the URL above can run commands on this machine as you.',
        'Connections from loopback, private (RFC 1918), link-local, CGNAT and ULA addresses are accepted; others are refused.',
        ...(tls
          ? []
          : [
              'Traffic is plaintext HTTP: others on the same network can read it, including the token. Use --tls-cert/--tls-key to encrypt it.',
            ]),
        '',
      ].join('\n'),
    )
  }

  registerCleanup(async () => {
    await removeServerLock(LOCK_NAME)
    server.stop(true)
    await sessionManager.destroyAll()
  })

  if (shouldOpen) await openInBrowser(signInUrl)
}
