import { createHash, randomUUID } from 'node:crypto'
import {
  type ChildProcess,
  spawn,
} from 'node:child_process'
import {
  createReadStream,
  createWriteStream,
  rmSync,
} from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SettingsJson } from '../utils/settings/types.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { quote } from '../utils/bash/shellQuote.js'
import { isInBundledMode } from '../utils/bundledMode.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
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
const SSH_CONNECT_TIMEOUT_MS = 15_000
const SSH_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const SSH_DEPLOY_TIMEOUT_MS = 5 * 60_000
const REMOTE_SOCKET_NAME = 'api.sock'

export type SSHConfig = NonNullable<SettingsJson['sshConfigs']>[number]

export type SSHConnection = {
  host: string
  sshArgs: string[]
  startDirectory: string | undefined
}

export type SSHSession = {
  proc: ChildProcess
  proxy: SSHAuthProxy
  remoteCwd: string
  createManager: (callbacks: SSHSessionCallbacks) => SSHSessionManager
  getStderrTail: () => string
}

type SSHSessionOptions = {
  host: string
  cwd?: string
  localVersion: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
  model?: string
}

type LocalSSHSessionOptions = Omit<
  SSHSessionOptions,
  'host' | 'localVersion' | 'extraCliArgs'
>

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
  createRemoteSocketDir?: () => string
}

export class SSHSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SSHSessionError'
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
  extraCliArgs?: string[]
}): string[] {
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
    ...(options.extraCliArgs ?? []),
  ]
}

const AUTH_ENV_VARS_TO_UNSET = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_TOKEN',
  'OPENAI_BASE_URL',
  'CLAUDE_CODE_OPENAI_UNIX_SOCKET',
  'CLAUDE_CODE_OPENAI_AUTH_MODE',
]

function authEnvironment(proxy: SSHAuthProxy, socketPath: string): string[] {
  return [
    'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1',
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
  cwd: string
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
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
  const envArgs = authEnvironment(proxy, options.remoteSocketPath)
  const command = [
    'env',
    ...AUTH_ENV_VARS_TO_UNSET.flatMap(key => ['-u', key]),
    ...envArgs,
    options.remoteBinaryPath,
    ...childArgs({
      ...options,
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
  remoteCwd: string,
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
    remoteCwd,
    createManager: callbacks => new SSHSessionManager(proc, callbacks),
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
  const args = [
    ...(deps.scriptArgs ?? defaultScriptArgs()),
    ...childArgs(options),
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
      authEnvironment(proxy, proxy.socketPath).map(value => {
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
    return createSession(proc, proxy, cwd)
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
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...connection.sshArgs,
  ]
}

async function runSSH(
  connection: SSHConnection,
  remoteCommand: string,
  timeout = SSH_CONNECT_TIMEOUT_MS,
): Promise<string> {
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
    throw new SSHSessionError(
      `SSH command failed for ${connection.host}: ${result.stderr.trim() || result.error || `exit ${result.code}`}`,
    )
  }
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
  const temporary = `${remotePath}.tmp.${randomUUID()}`
  const command = `set -eu; temporary=${quote([temporary])}; trap 'rm -f -- "$temporary"' EXIT HUP INT TERM; mkdir -p -- ${quote([dirname(remotePath)])}; cat > "$temporary"; chmod 755 "$temporary"; mv -f -- "$temporary" ${quote([remotePath])}; trap - EXIT HUP INT TERM`
  const proc = spawn(
    'ssh',
    [...baseSSHArgs(connection), '--', connection.host, command],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )
  let stderr = ''
  proc.stderr?.on('data', chunk => {
    stderr = `${stderr}${String(chunk)}`.slice(-4000)
  })
  const source = createReadStream(localPath)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      source.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      finish(new SSHSessionError('Timed out deploying Claude over SSH'))
    }, SSH_DEPLOY_TIMEOUT_MS)
    source.once('error', error => {
      proc.kill('SIGTERM')
      finish(new SSHSessionError('Failed to read Claude deployment binary', {
        cause: error,
      }))
    })
    proc.once('error', error => {
      finish(new SSHSessionError('Failed to start SSH deployment', { cause: error }))
    })
    proc.once('close', code => {
      if (code === 0) finish()
      else {
        finish(
          new SSHSessionError(
            `Failed to deploy Claude over SSH: ${stderr.trim() || `exit ${code}`}`,
          ),
        )
      }
    })
    source.pipe(proc.stdin!)
  })
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
      timeout: SSH_CONNECT_TIMEOUT_MS,
      preserveOutputOnError: true,
      stdin: 'ignore',
    },
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
  const check = await execFileNoThrowWithCwd(
    'ssh',
    [
      ...baseSSHArgs(connection),
      '--',
      connection.host,
      `test -x ${quote([remotePath])} && ${quote([remotePath])} --version`,
    ],
    { timeout: SSH_CONNECT_TIMEOUT_MS, preserveOutputOnError: true },
  )
  if (check.code === 0 && check.stdout.includes(version)) return remotePath

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
  const connection = resolveSSHConnection(options.host)
  progress.onProgress?.(`Probing ${connection.host}…`)
  const probe = await (deps.probeRemote ?? probeRemote)(connection, options.cwd)
  const remoteBinaryPath = await (
    deps.ensureRemoteBinary ?? ensureRemoteBinary
  )(
    connection,
    probe,
    options.localVersion,
    progress.onProgress,
  )
  const proxy = await (deps.startProxy ?? defaultProxy)()
  const remoteSocketDir =
    deps.createRemoteSocketDir?.() ?? `/tmp/claude-ssh-${randomUUID()}`
  const remoteSocketPath = `${remoteSocketDir}/${REMOTE_SOCKET_NAME}`
  const remoteCommand = `set -eu; trap ${quote([`rm -rf -- ${remoteSocketDir}`])} EXIT HUP INT TERM; ${buildRemoteLaunchCommand({
    remoteBinaryPath,
    remoteSocketPath,
    cwd: probe.cwd,
    permissionMode: options.permissionMode,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    extraCliArgs: options.extraCliArgs,
    model: options.model,
    provider: proxy.provider,
    oauth: proxy.authKind === 'oauth',
  })}`
  const cleanupRemoteSocketDirectory =
    deps.removeRemoteSocketDirectory ?? removeRemoteSocketDirectory

  try {
    await (
      deps.prepareRemoteSocketDirectory ?? prepareRemoteSocketDirectory
    )(connection, remoteSocketDir)
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
    proc.once('close', () => {
      void cleanupRemoteSocketDirectory(connection, remoteSocketDir)
    })
    proc.once('error', () => {
      void cleanupRemoteSocketDirectory(connection, remoteSocketDir)
    })
    return createSession(proc, proxy, probe.cwd)
  } catch (error) {
    proxy.stop()
    await cleanupRemoteSocketDirectory(connection, remoteSocketDir)
    throw new SSHSessionError(`Failed to start SSH session to ${connection.host}`, {
      cause: error,
    })
  }
}
