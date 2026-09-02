import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  type ChildProcess,
  spawn,
} from 'node:child_process'
import {
  createReadStream,
  createWriteStream,
  rmSync,
} from 'node:fs'
import { chmod, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SettingsJson } from '../utils/settings/types.js'
import {
  getInitialSettings,
  getSettingsForSource,
} from '../utils/settings/settings.js'
import {
  encodeSSHPermissionBootstrap,
  extractEditablePermissionOverlay,
} from './managedSSHPermissions.js'
import { quote } from '../utils/bash/shellQuote.js'
import { isInBundledMode } from '../utils/bundledMode.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { logForDebugging } from '../utils/debug.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  SSHSessionManager,
  type SSHSessionCallbacks,
} from './SSHSessionManager.js'
import {
  startSSHAuthProxy,
  type SSHAuthProxy,
} from './sshAuthProxy.js'

const FORK_RELEASES_URL =
  'https://github.com/Esonhugh/claude-code/releases/download'
const SSH_COMMAND_TIMEOUT_MS = 2 * 60_000
const SSH_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const SSH_DEPLOY_TIMEOUT_MS = 5 * 60_000
const SSH_DEPLOY_ATTEMPTS = 3
const SSH_DEPLOY_CHUNK_SIZE = 16 * 1024 * 1024
const SSH_CONTROL_STOP_TIMEOUT_MS = 10_000
const REMOTE_SOCKET_NAME = 'api.sock'

export type SSHConfig = NonNullable<SettingsJson['sshConfigs']>[number]

export type SSHConnection = {
  host: string
  sshArgs: string[]
  startDirectory: string | undefined
  controlPath?: string
}

export type SSHSession = {
  proc: ChildProcess
  proxy: SSHAuthProxy
  target: string
  remoteCwd: string
  sshRemoteToken?: string
  createManager: (callbacks: SSHSessionCallbacks) => SSHSessionManager
  getStderrTail: () => string
}

type SSHSessionOptions = {
  host: string
  cwd?: string
  localVersion: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  allowDangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
  model?: string
}

type LocalSSHSessionOptions = Omit<SSHSessionOptions, 'host' | 'localVersion'> & {
  target?: string
}

type SSHSessionProgress = {
  onProgress?: (message: string) => void
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    stdio: ['pipe', 'pipe', 'pipe']
  },
) => ChildProcess

type LocalSSHSessionDeps = {
  startProxy?: () => Promise<SSHAuthProxy>
  spawnProcess?: SpawnProcess
  execPath?: string
  scriptArgs?: string[]
}

type RemoteSSHSessionDeps = {
  probeRemote?: typeof probeRemote
  ensureRemoteBinary?: typeof ensureRemoteBinary
  startProxy?: () => Promise<SSHAuthProxy>
  spawnProcess?: SpawnProcess
  prepareRemoteSocketDirectory?: typeof prepareRemoteSocketDirectory
  removeRemoteSocketDirectory?: typeof removeRemoteSocketDirectory
  stopControlMaster?: typeof stopSSHControlMaster
  registerCleanup?: typeof registerCleanup
  createRemoteSocketDir?: () => string
}

export class SSHSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SSHSessionError'
  }
}

const LOCAL_ONLY_CHILD_OPTIONS = new Set([
  '--managed-settings',
  '--setting-sources',
  '--settings',
])

const REMOTE_OPTIONS_WITH_REQUIRED_VALUES = new Set([
  '--advisor',
  '--agent',
  '--agents',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--effort',
  '--fallback-model',
  '--max-budget-usd',
  '--max-thinking-tokens',
  '--max-turns',
  '--model',
  '--permission-mode',
  '--plugin-dir',
  '--resume-session-at',
  '--rewind-files',
  '--session-id',
  '--system-prompt',
  '--system-prompt-file',
  '--task-budget',
  '--thinking',
  '--workload',
])

function assertRemoteChildArgs(args: readonly string[]): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') return
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (LOCAL_ONLY_CHILD_OPTIONS.has(name)) {
      throw new SSHSessionError(
        'A local-only option cannot be forwarded to an SSH child',
      )
    }
    if (equals === -1 && REMOTE_OPTIONS_WITH_REQUIRED_VALUES.has(name)) index++
  }
}

export function resolveSSHConnection(
  value: string,
  configs: SSHConfig[] = getInitialSettings().sshConfigs ?? [],
): SSHConnection {
  const config = configs.find(item => item.id === value)
  const host = config?.sshHost ?? value
  const hasInvalidHostCharacter = [...host].some(character => {
    const code = character.charCodeAt(0)
    return code <= 0x20 || code === 0x7f
  })
  if (!host || host.startsWith('-') || hasInvalidHostCharacter) {
    throw new SSHSessionError(`Invalid SSH host or config: ${value}`)
  }

  const sshArgs: string[] = []
  if (config?.sshPort !== undefined) {
    if (
      !Number.isInteger(config.sshPort) ||
      config.sshPort < 1 ||
      config.sshPort > 65535
    ) {
      throw new SSHSessionError(`Invalid SSH port: ${config.sshPort}`)
    }
    sshArgs.push('-p', String(config.sshPort))
  }
  if (config?.sshIdentityFile) {
    sshArgs.push('-i', config.sshIdentityFile)
  }
  return {
    host,
    sshArgs,
    startDirectory: config?.startDirectory,
  }
}

function childArgs(options: {
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  allowDangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
}): string[] {
  assertRemoteChildArgs(options.extraCliArgs ?? [])
  return [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    ...(options.permissionMode
      ? ['--permission-mode', options.permissionMode]
      : []),
    ...(options.dangerouslySkipPermissions
      ? ['--dangerously-skip-permissions']
      : []),
    ...(options.allowDangerouslySkipPermissions
      ? ['--allow-dangerously-skip-permissions']
      : []),
    ...(options.extraCliArgs ?? []),
  ]
}

const AUTH_ENV_VARS_TO_UNSET = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_TOKEN',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_OPENAI_UNIX_SOCKET',
  'CLAUDE_CODE_OPENAI_AUTH_MODE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_SSH_LOCAL_UI',
  'CLAUDE_CODE_SSH_REMOTE',
  'CLAUDE_CODE_SSH_REMOTE_TOKEN',
]

function authEnvironment(
  proxy: SSHAuthProxy,
  socketPath: string,
  sshRemote: boolean,
  sshRemoteToken?: string,
): string[] {
  return [
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1',
    ...(sshRemote
      ? [
          'CLAUDE_CODE_SSH_REMOTE=1',
          `CLAUDE_CODE_SSH_REMOTE_TOKEN=${sshRemoteToken}`,
          `CLAUDE_CODE_SSH_PERMISSION_BOOTSTRAP=${encodeSSHPermissionBootstrap(
            extractEditablePermissionOverlay([
              getSettingsForSource('userSettings'),
              getSettingsForSource('projectSettings'),
              getSettingsForSource('localSettings'),
              getSettingsForSource('flagSettings'),
            ]),
          )}`,
        ]
      : []),
    `CLAUDE_CODE_USE_OPENAI=${proxy.provider === 'openai' ? '1' : '0'}`,
    'CLAUDE_CODE_USE_BEDROCK=0',
    'CLAUDE_CODE_USE_VERTEX=0',
    'CLAUDE_CODE_USE_FOUNDRY=0',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'DISABLE_AUTOUPDATER=1',
    ...(proxy.provider === 'openai'
      ? [
          `CLAUDE_CODE_OPENAI_UNIX_SOCKET=${socketPath}`,
          `CLAUDE_CODE_OPENAI_AUTH_MODE=${proxy.openAIAuthMode ?? 'platform'}`,
          'CLAUDE_CODE_OAUTH_TOKEN=ssh-anthropic-placeholder',
        ]
      : [
          `ANTHROPIC_UNIX_SOCKET=${socketPath}`,
          'ANTHROPIC_BASE_URL=http://localhost',
          ...(proxy.authKind === 'oauth'
            ? ['CLAUDE_CODE_OAUTH_TOKEN=ssh-oauth-placeholder']
            : ['ANTHROPIC_API_KEY=ssh-api-key-placeholder']),
        ]),
  ]
}

export function buildRemoteLaunchCommand(options: {
  remoteBinaryPath: string
  remoteSocketPath: string
  sshRemoteToken: string
  cwd: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  allowDangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
  model?: string
  provider?: SSHAuthProxy['provider']
  oauth: boolean
}): string {
  const authKind: SSHAuthProxy['authKind'] = options.oauth ? 'oauth' : 'api-key'
  const provider = options.provider ?? 'anthropic'
  const proxy = {
    provider,
    authKind,
    ...(provider === 'openai'
      ? { openAIAuthMode: options.oauth ? 'chatgpt' : 'platform' }
      : {}),
  } as SSHAuthProxy
  const envArgs = authEnvironment(
    proxy,
    options.remoteSocketPath,
    true,
    options.sshRemoteToken,
  )
  const command = [
    'env',
    ...AUTH_ENV_VARS_TO_UNSET.flatMap(key => ['-u', key]),
    ...envArgs,
    options.remoteBinaryPath,
    ...childArgs({
      ...options,
      // The local TUI is the permission authority. Keep the remote stream-json
      // child capable of accepting an explicit /yolo control request; the
      // user's --allow-* flag still controls whether the local Shift+Tab
      // carousel exposes bypass mode.
      allowDangerouslySkipPermissions: true,
      extraCliArgs: [
        ...(options.model ? ['--model', options.model] : []),
        ...(options.extraCliArgs ?? []),
      ],
    }),
  ]
  return `cd -- ${quote([options.cwd])} && ${quote(command)}`
}

function defaultScriptArgs(): string[] {
  if (isInBundledMode() || !process.argv[1]) return []
  return [process.argv[1]]
}

async function defaultProxy(): Promise<SSHAuthProxy> {
  const dir = await mkdtemp(join(tmpdir(), 'claude-ssh-proxy-'))
  try {
    const proxy = await startSSHAuthProxy({ socketPath: join(dir, 'api.sock') })
    return {
      ...proxy,
      stop: () => {
        proxy.stop()
        void rm(dir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

function createSession(
  proc: ChildProcess,
  proxy: SSHAuthProxy,
  target: string,
  remoteCwd: string,
  sshRemoteToken?: string,
): SSHSession {
  const stderrLines: string[] = []
  let stderrRemainder = ''
  proc.stderr?.on('data', chunk => {
    const parts = `${stderrRemainder}${String(chunk)}`.split('\n')
    stderrRemainder = parts.pop() ?? ''
    stderrLines.push(...parts)
    while (stderrLines.length > 20) stderrLines.shift()
  })
  proc.once('error', () => proxy.stop())
  proc.once('close', () => proxy.stop())

  return {
    proc,
    proxy,
    target,
    remoteCwd,
    sshRemoteToken,
    createManager: callbacks =>
      new SSHSessionManager(proc, callbacks, sshRemoteToken),
    getStderrTail: () => [...stderrLines, stderrRemainder].filter(Boolean).join('\n'),
  }
}

export async function createLocalSSHSession(
  options: LocalSSHSessionOptions,
  deps: LocalSSHSessionDeps = {},
): Promise<SSHSession> {
  const startProxy = deps.startProxy ?? defaultProxy
  const spawnProcess = deps.spawnProcess ?? spawn
  const proxy = await startProxy()
  const cwd = options.cwd ?? process.cwd()
  const sshRemoteToken = randomBytes(32).toString('hex')
  const args = [
    ...(deps.scriptArgs ?? defaultScriptArgs()),
    ...childArgs({
      ...options,
      extraCliArgs: [
        ...(options.model ? ['--model', options.model] : []),
        ...(options.extraCliArgs ?? []),
      ],
    }),
  ]
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
  for (const key of AUTH_ENV_VARS_TO_UNSET) delete env[key]
  Object.assign(
    env,
    Object.fromEntries(
      authEnvironment(proxy, proxy.socketPath, true, sshRemoteToken).map(value => {
        const separator = value.indexOf('=')
        return [value.slice(0, separator), value.slice(separator + 1)]
      }),
    ),
  )

  try {
    const proc = spawnProcess(deps.execPath ?? process.execPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return createSession(
      proc,
      proxy,
      options.target ?? 'localhost',
      cwd,
      sshRemoteToken,
    )
  } catch (error) {
    proxy.stop()
    throw new SSHSessionError('Failed to start local SSH test session', {
      cause: error,
    })
  }
}

function baseSSHArgs(connection: SSHConnection): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=30',
    '-o',
    'ConnectionAttempts=3',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...(connection.controlPath
      ? [
          '-o',
          'ControlMaster=auto',
          '-o',
          `ControlPath=${connection.controlPath}`,
          '-o',
          'ControlPersist=10m',
        ]
      : []),
    ...connection.sshArgs,
  ]
}

async function runSSH(
  connection: SSHConnection,
  remoteCommand: string,
  timeout = SSH_COMMAND_TIMEOUT_MS,
): Promise<string> {
  logForDebugging(
    `[SSH] command start host=${connection.host} timeoutMs=${timeout} multiplexed=${Boolean(connection.controlPath)}`,
  )
  const startedAt = Date.now()
  const result = await execFileNoThrowWithCwd(
    'ssh',
    [...baseSSHArgs(connection), '--', connection.host, remoteCommand],
    {
      cwd: process.cwd(),
      timeout,
      preserveOutputOnError: true,
      stdin: 'ignore',
    },
  )
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.error || `exit ${result.code}`
    logForDebugging(
      `[SSH] command failed host=${connection.host} durationMs=${Date.now() - startedAt} code=${result.code} detail=${detail}`,
      { level: 'error' },
    )
    throw new SSHSessionError(
      `SSH command failed for ${connection.host}: ${detail}`,
    )
  }
  logForDebugging(
    `[SSH] command complete host=${connection.host} durationMs=${Date.now() - startedAt}`,
  )
  return result.stdout
}

type RemoteProbe = {
  platform: 'linux-x64' | 'linux-arm64'
  home: string
  cwd: string
}

type RemoteBinaryTarget = RemoteProbe['platform'] | 'linux-x64-baseline'

async function probeRemote(
  connection: SSHConnection,
  requestedCwd: string | undefined,
): Promise<RemoteProbe> {
  const cwd = requestedCwd ?? connection.startDirectory ?? '~'
  logForDebugging(`[SSH] probe start host=${connection.host} cwd=${cwd}`)
  const script = [
    'set -eu',
    `requested=${quote([cwd])}`,
    'case "$requested" in "~") requested="$HOME" ;; "~/"*) requested="$HOME/${requested#\~/}" ;; esac',
    'cd -- "$requested"',
    'printf "%s\\n%s\\n%s\\n%s\\n" "$(uname -s)" "$(uname -m)" "$HOME" "$(pwd -P)"',
  ].join('; ')
  const lines = (await runSSH(connection, script))
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const [os, arch, home, remoteCwd] = lines
  if (os !== 'Linux') {
    throw new SSHSessionError(`Unsupported remote operating system: ${os || 'unknown'}`)
  }
  const platform =
    arch === 'x86_64' || arch === 'amd64'
      ? 'linux-x64'
      : arch === 'aarch64' || arch === 'arm64'
        ? 'linux-arm64'
        : undefined
  if (!platform) {
    throw new SSHSessionError(`Unsupported remote architecture: ${arch || 'unknown'}`)
  }
  if (!home?.startsWith('/') || !remoteCwd?.startsWith('/')) {
    throw new SSHSessionError('Remote probe returned invalid HOME or cwd')
  }
  logForDebugging(
    `[SSH] probe complete host=${connection.host} platform=${platform} home=${home} cwd=${remoteCwd}`,
  )
  return { platform, home, cwd: remoteCwd }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function remoteBinaryTarget(probe: RemoteProbe): RemoteBinaryTarget {
  return probe.platform === 'linux-x64'
    ? 'linux-x64-baseline'
    : probe.platform
}

function releaseAssetName(
  version: string,
  target: RemoteBinaryTarget,
): string {
  return `claude-code-v${version}-${target}`
}

function releaseAssetURL(version: string, name: string): string {
  return `${FORK_RELEASES_URL}/v${version}/${name}`
}

async function fetchWithTimeout(
  url: string,
  message: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      signal: AbortSignal.timeout(SSH_DOWNLOAD_TIMEOUT_MS),
    })
  } catch (error) {
    throw new SSHSessionError(message, { cause: error })
  }
}

async function getReleaseChecksum(
  version: string,
  assetName: string,
): Promise<string> {
  const checksumsResponse = await fetchWithTimeout(
    releaseAssetURL(version, 'SHA256SUMS.txt'),
    `Failed to fetch Claude ${version} checksums`,
  )
  if (!checksumsResponse.ok) {
    throw new SSHSessionError(
      `Failed to fetch Claude ${version} checksums: HTTP ${checksumsResponse.status}`,
    )
  }
  const line = (await checksumsResponse.text())
    .split('\n')
    .find(candidate => candidate.trim().endsWith(`  ${assetName}`))
  const checksum = line?.trim().split(/\s+/)[0]
  if (!checksum || !/^[0-9a-f]{64}$/i.test(checksum)) {
    throw new SSHSessionError(
      `Claude ${version} release does not provide a checksum for ${assetName}`,
    )
  }
  return checksum.toLowerCase()
}

async function ensureLocalRemoteBinary(
  version: string,
  target: RemoteBinaryTarget,
  onProgress?: (message: string) => void,
): Promise<string> {
  const base = join(tmpdir(), 'claude-ssh-binaries', version, target)
  const binary = join(base, 'claude')
  const assetName = releaseAssetName(version, target)
  const packagedAsset = join(
    dirname(process.execPath),
    'dist',
    'release',
    assetName,
  )
  try {
    if ((await stat(packagedAsset)).isFile()) return packagedAsset
  } catch {
    // Use the verified release asset below when no local build exists.
  }

  const checksum = await getReleaseChecksum(version, assetName)
  try {
    if ((await stat(binary)).isFile() && (await sha256File(binary)) === checksum) {
      return binary
    }
  } catch {
    // Download a missing or invalid cache entry below.
  }

  onProgress?.(`Downloading Claude ${version} for ${target}…`)
  await mkdir(base, { recursive: true })
  const temporary = `${binary}.tmp.${process.pid}.${randomUUID()}`
  try {
    const response = await fetchWithTimeout(
      releaseAssetURL(version, assetName),
      `Failed to download Claude ${version} for ${target}`,
    )
    if (!response.ok || !response.body) {
      throw new SSHSessionError(
        `Failed to download Claude ${version} for ${target}: HTTP ${response.status}`,
      )
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(temporary, { mode: 0o755 }),
    )
    const actual = await sha256File(temporary)
    if (actual !== checksum) {
      throw new SSHSessionError(
        `Downloaded Claude checksum mismatch: expected ${checksum}, got ${actual}`,
      )
    }
    await chmod(temporary, 0o755)
    await rename(temporary, binary)
    return binary
  } finally {
    rmSync(temporary, { force: true })
  }
}

async function uploadBinary(
  connection: SSHConnection,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const expected = await sha256File(localPath)
  const size = (await stat(localPath)).size
  const chunkCount = Math.ceil(size / SSH_DEPLOY_CHUNK_SIZE)
  const temporary = `${remotePath}.tmp.${randomUUID()}`
  const local = await open(localPath, 'r')

  logForDebugging(
    `[SSH] deploy start host=${connection.host} remotePath=${remotePath} size=${size} sha256=${expected} chunks=${chunkCount}`,
  )
  try {
    await runSSH(
      connection,
      `set -eu; mkdir -p -- ${quote([dirname(remotePath)])}; : > ${quote([temporary])}`,
    )
    for (let chunk = 0; chunk < chunkCount; chunk++) {
      const offset = chunk * SSH_DEPLOY_CHUNK_SIZE
      const length = Math.min(SSH_DEPLOY_CHUNK_SIZE, size - offset)
      const buffer = Buffer.allocUnsafe(length)
      const { bytesRead } = await local.read(buffer, 0, length, offset)
      if (bytesRead !== length) {
        throw new SSHSessionError('Failed to read complete Claude deployment chunk')
      }
      const chunkChecksum = createHash('sha256').update(buffer).digest('hex')
      let lastError: Error | undefined

      for (let attempt = 1; attempt <= SSH_DEPLOY_ATTEMPTS; attempt++) {
        logForDebugging(
          `[SSH] deploy chunk start host=${connection.host} chunk=${chunk + 1}/${chunkCount} attempt=${attempt}/${SSH_DEPLOY_ATTEMPTS}`,
        )
        const command = `set -eu; chunk=${quote([`${temporary}.chunk`])}; expected=${quote([chunkChecksum])}; trap 'rm -f -- "$chunk"' EXIT HUP INT TERM; cat > "$chunk"; actual=$(sha256sum "$chunk"); actual=${'${actual%% *}'}; test "$actual" = "$expected"; cat "$chunk" >> ${quote([temporary])}; rm -f -- "$chunk"; trap - EXIT HUP INT TERM`
        const proc = spawn(
          'ssh',
          [...baseSSHArgs(connection), '--', connection.host, command],
          { stdio: ['pipe', 'pipe', 'pipe'] },
        )
        let stderr = ''
        proc.stderr?.on('data', data => {
          stderr = `${stderr}${String(data)}`.slice(-4000)
        })

        try {
          await new Promise<void>((resolve, reject) => {
            let settled = false
            const finish = (error?: Error) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              if (error) reject(error)
              else resolve()
            }
            const timer = setTimeout(() => {
              proc.kill('SIGTERM')
              finish(new SSHSessionError('Timed out deploying Claude chunk over SSH'))
            }, SSH_DEPLOY_TIMEOUT_MS)
            proc.once('error', error => {
              finish(new SSHSessionError('Failed to start SSH deployment', { cause: error }))
            })
            proc.once('close', code => {
              if (code === 0) finish()
              else {
                finish(
                  new SSHSessionError(
                    `Failed to deploy Claude chunk over SSH: ${stderr.trim() || `exit ${code}`}`,
                  ),
                )
              }
            })
            proc.stdin!.end(buffer)
          })
          logForDebugging(
            `[SSH] deploy chunk complete host=${connection.host} chunk=${chunk + 1}/${chunkCount} attempt=${attempt}/${SSH_DEPLOY_ATTEMPTS}`,
          )
          lastError = undefined
          break
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error))
          logForDebugging(
            `[SSH] deploy chunk failed host=${connection.host} chunk=${chunk + 1}/${chunkCount} attempt=${attempt}/${SSH_DEPLOY_ATTEMPTS} detail=${lastError.message}`,
            { level: 'error' },
          )
        }
      }
      if (lastError) throw lastError
    }

    await runSSH(
      connection,
      `set -eu; expected=${quote([expected])}; actual=$(sha256sum ${quote([temporary])}); actual=${'${actual%% *}'}; test "$actual" = "$expected"; chmod 755 ${quote([temporary])}; mv -f -- ${quote([temporary])} ${quote([remotePath])}`,
    )
    logForDebugging(`[SSH] deploy complete host=${connection.host}`)
  } catch (error) {
    await runSSH(
      connection,
      `rm -f -- ${quote([temporary, `${temporary}.chunk`])}`,
    ).catch(() => {})
    throw error
  } finally {
    await local.close()
  }
}

async function prepareRemoteSocketDirectory(
  connection: SSHConnection,
  remoteSocketDir: string,
): Promise<void> {
  await runSSH(
    connection,
    `mkdir -m 700 -- ${quote([remoteSocketDir])}`,
  )
}

async function removeRemoteSocketDirectory(
  connection: SSHConnection,
  remoteSocketDir: string,
): Promise<void> {
  await execFileNoThrowWithCwd(
    'ssh',
    [
      ...baseSSHArgs(connection),
      '--',
      connection.host,
      `rm -rf -- ${quote([remoteSocketDir])}`,
    ],
    {
      cwd: process.cwd(),
      timeout: SSH_COMMAND_TIMEOUT_MS,
      preserveOutputOnError: true,
      stdin: 'ignore',
    },
  )
}

async function stopSSHControlMaster(connection: SSHConnection): Promise<void> {
  if (!connection.controlPath) return
  const result = await execFileNoThrowWithCwd(
    'ssh',
    [
      '-S',
      connection.controlPath,
      '-O',
      'exit',
      '--',
      connection.host,
    ],
    {
      cwd: process.cwd(),
      timeout: SSH_CONTROL_STOP_TIMEOUT_MS,
      preserveOutputOnError: true,
      stdin: 'ignore',
    },
  )
  logForDebugging(
    `[SSH] control master stop host=${connection.host} code=${result.code}`,
  )
}

async function ensureRemoteBinary(
  connection: SSHConnection,
  probe: RemoteProbe,
  version: string,
  onProgress?: (message: string) => void,
): Promise<string> {
  const target = remoteBinaryTarget(probe)
  const remotePath = `${probe.home}/.cache/claude-ssh/${version}/${target}/claude`
  logForDebugging(
    `[SSH] remote binary check start host=${connection.host} version=${version} target=${target} path=${remotePath}`,
  )
  const check = await execFileNoThrowWithCwd(
    'ssh',
    [
      ...baseSSHArgs(connection),
      '--',
      connection.host,
      `test -x ${quote([remotePath])} && ${quote([remotePath])} --version`,
    ],
    { timeout: SSH_COMMAND_TIMEOUT_MS, preserveOutputOnError: true },
  )
  if (check.code === 0 && check.stdout.includes(version)) {
    logForDebugging(
      `[SSH] remote binary cache hit host=${connection.host} version=${version} target=${target}`,
    )
    return remotePath
  }
  logForDebugging(
    `[SSH] remote binary cache miss host=${connection.host} version=${version} target=${target} code=${check.code} detail=${check.stderr.trim() || check.error || 'version mismatch'}`,
  )

  const localPath = await ensureLocalRemoteBinary(
    version,
    target,
    onProgress,
  )
  onProgress?.(`Deploying Claude ${version} ${target} to ${connection.host}…`)
  await uploadBinary(connection, localPath, remotePath)
  return remotePath
}

export async function createSSHSession(
  options: SSHSessionOptions,
  progress: SSHSessionProgress = {},
  deps: RemoteSSHSessionDeps = {},
): Promise<SSHSession> {
  const resolvedConnection = resolveSSHConnection(options.host)
  const connection = {
    ...resolvedConnection,
    controlPath: join(tmpdir(), `cc-ssh-${randomBytes(12).toString('hex')}`),
  }
  logForDebugging(
    `[SSH] session start host=${connection.host} requestedCwd=${options.cwd ?? connection.startDirectory ?? '~'} multiplexed=true`,
  )
  const stopControlMaster = deps.stopControlMaster ?? stopSSHControlMaster
  let probe: RemoteProbe
  let remoteBinaryPath: string
  let proxy: SSHAuthProxy
  try {
    progress.onProgress?.(`Probing ${connection.host}…`)
    probe = await (deps.probeRemote ?? probeRemote)(connection, options.cwd)
    remoteBinaryPath = await (
      deps.ensureRemoteBinary ?? ensureRemoteBinary
    )(
      connection,
      probe,
      options.localVersion,
      progress.onProgress,
    )
    proxy = await (deps.startProxy ?? defaultProxy)()
  } catch (error) {
    logForDebugging(
      `[SSH] session start failed host=${connection.host} detail=${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
    await stopControlMaster(connection)
    throw error
  }

  const remoteSocketDir =
    deps.createRemoteSocketDir?.() ?? `/tmp/claude-ssh-${randomUUID()}`
  const remoteSocketPath = `${remoteSocketDir}/${REMOTE_SOCKET_NAME}`
  const sshRemoteToken = randomBytes(32).toString('hex')
  const remoteCommand = `set -eu; trap ${quote([`rm -rf -- ${remoteSocketDir}`])} EXIT HUP INT TERM; ${buildRemoteLaunchCommand({
    remoteBinaryPath,
    remoteSocketPath,
    sshRemoteToken,
    cwd: probe.cwd,
    permissionMode: options.permissionMode,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
    extraCliArgs: options.extraCliArgs,
    model: options.model,
    provider: proxy.provider,
    oauth: proxy.authKind === 'oauth',
  })}`
  const cleanupRemoteSocketDirectory =
    deps.removeRemoteSocketDirectory ?? removeRemoteSocketDirectory

  try {
    logForDebugging(
      `[SSH] socket directory prepare start host=${connection.host} path=${remoteSocketDir}`,
    )
    await (
      deps.prepareRemoteSocketDirectory ?? prepareRemoteSocketDirectory
    )(connection, remoteSocketDir)
    logForDebugging(
      `[SSH] remote child spawn start host=${connection.host} cwd=${probe.cwd} provider=${proxy.provider} sshRemote=true bypass=${options.permissionMode === 'bypassPermissions' || options.dangerouslySkipPermissions === true}`,
    )
    const proc = (deps.spawnProcess ?? spawn)(
      'ssh',
      [
        ...baseSSHArgs(connection),
        '-T',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'StreamLocalBindUnlink=yes',
        '-R',
        `${remoteSocketPath}:${proxy.socketPath}`,
        '--',
        connection.host,
        remoteCommand,
      ],
      {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let cleanupPromise: Promise<void> | undefined
    let unregisterCleanup = () => {}
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGTERM')
        }
        try {
          await cleanupRemoteSocketDirectory(connection, remoteSocketDir)
        } finally {
          try {
            proxy.stop()
          } finally {
            try {
              await stopControlMaster(connection)
            } finally {
              unregisterCleanup()
            }
          }
        }
      })()
      return cleanupPromise
    }
    unregisterCleanup = (deps.registerCleanup ?? registerCleanup)(cleanup)
    proc.once('close', code => {
      logForDebugging(
        `[SSH] remote child closed host=${connection.host} code=${code ?? 'null'}`,
      )
      void cleanup()
    })
    proc.once('error', error => {
      logForDebugging(
        `[SSH] remote child error host=${connection.host} detail=${error.message}`,
        { level: 'error' },
      )
      void cleanup()
    })
    logForDebugging(`[SSH] session ready host=${connection.host} cwd=${probe.cwd}`)
    return createSession(
      proc,
      proxy,
      options.host,
      probe.cwd,
      sshRemoteToken,
    )
  } catch (error) {
    logForDebugging(
      `[SSH] session start failed host=${connection.host} detail=${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    )
    try {
      proxy.stop()
    } finally {
      try {
        await cleanupRemoteSocketDirectory(connection, remoteSocketDir)
      } finally {
        await stopControlMaster(connection)
      }
    }
    throw new SSHSessionError(`Failed to start SSH session to ${connection.host}`, {
      cause: error,
    })
  }
}
