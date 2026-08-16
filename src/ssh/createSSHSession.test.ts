import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, it } from 'bun:test'
import {
  buildRemoteLaunchCommand,
  createLocalSSHSession,
  createSSHSession,
  resolveSSHConnection,
  SSHSessionError,
} from './createSSHSession.js'

type FakeProcess = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: () => boolean
}

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = () => true
  return proc
}

describe('SSH connection config', () => {
  it('resolves managed config ids without putting user input in shell syntax', () => {
    assert.deepEqual(
      resolveSSHConnection('prod', [
        {
          id: 'prod',
          name: 'Production',
          sshHost: 'user@example.com',
          sshPort: 2222,
          sshIdentityFile: '/tmp/key file',
          startDirectory: '~/project',
        },
      ]),
      {
        host: 'user@example.com',
        sshArgs: ['-p', '2222', '-i', '/tmp/key file'],
        startDirectory: '~/project',
      },
    )
  })

  it('treats an unmatched value as an SSH host or alias', () => {
    assert.deepEqual(resolveSSHConnection('pojun-master', []), {
      host: 'pojun-master',
      sshArgs: [],
      startDirectory: undefined,
    })
  })

  it('rejects hosts that could be parsed as SSH options or multiple arguments', () => {
    assert.throws(() => resolveSSHConnection('-oProxyCommand=bad', []), /Invalid SSH host/)
    assert.throws(() => resolveSSHConnection('host name', []), /Invalid SSH host/)
  })
})

describe('remote launch command', () => {
  it('configures an OpenAI socket tunnel without embedding credentials', () => {
    const command = buildRemoteLaunchCommand({
      remoteBinaryPath: '/tmp/claude',
      remoteSocketPath: '/tmp/api.sock',
      cwd: '/tmp/project',
      provider: 'openai',
      oauth: true,
    })

    assert.match(command, /CLAUDE_CODE_USE_OPENAI\\=1/)
    assert.match(command, /CLAUDE_CODE_OPENAI_UNIX_SOCKET\\=\/tmp\/api\.sock/)
    assert.match(command, /CLAUDE_CODE_OPENAI_AUTH_MODE\\=chatgpt/)
    assert.equal(command.includes('OPENAI_API_KEY='), false)
    assert.equal(command.includes('OPENAI_AUTH_TOKEN='), false)
  })

  it('forwards the resolved local model to the remote child', () => {
    const command = buildRemoteLaunchCommand({
      remoteBinaryPath: '/tmp/claude',
      remoteSocketPath: '/tmp/api.sock',
      cwd: '/tmp/project',
      model: 'gateway-model',
      oauth: false,
    })

    assert.match(command, /--model gateway-model/)
  })

  it('quotes paths and forwarded values as POSIX shell arguments', () => {
    const command = buildRemoteLaunchCommand({
      remoteBinaryPath: "/tmp/claude's binary",
      remoteSocketPath: '/tmp/socket path',
      cwd: "/tmp/work dir'quoted",
      permissionMode: 'acceptEdits',
      dangerouslySkipPermissions: true,
      extraCliArgs: ['--model', 'model with spaces; touch /tmp/pwned'],
      oauth: true,
    })

    assert.match(command, /cd --/)
    assert.match(command, /ANTHROPIC_UNIX_SOCKET=/)
    assert.match(command, /ANTHROPIC_BASE_URL\\=http\\:\/\/localhost/)
    assert.match(command, /--input-format stream-json/)
    assert.match(command, /--output-format stream-json/)
    assert.match(command, /--permission-prompt-tool stdio/)
    assert.match(command, /--permission-mode acceptEdits/)
    assert.match(command, /--dangerously-skip-permissions/)
    assert.match(command, /'model with spaces; touch \/tmp\/pwned'/)
    assert.equal(command.includes("--model model with spaces; touch"), false)
    assert.equal(command.includes('exec '), false)
  })
})

describe('local SSH session', () => {
  it('forwards the resolved model to the local child', async () => {
    const proc = createFakeProcess()
    let spawnArgs: string[] = []

    await createLocalSSHSession(
      { cwd: '/tmp/project', model: 'gateway-model' },
      {
        startProxy: async () => ({
          socketPath: '/tmp/local.sock',
          provider: 'anthropic',
          authKind: 'oauth',
          stop() {},
        }),
        spawnProcess: (_command, args) => {
          spawnArgs = args
          return proc as never
        },
        execPath: '/tmp/claude',
      },
    )

    assert.deepEqual(spawnArgs.slice(-2), ['--model', 'gateway-model'])
  })

  it('returns a usable session and stops the proxy if child startup fails', async () => {
    const proc = createFakeProcess()
    let proxyStopped = 0
    let spawnEnv: NodeJS.ProcessEnv | undefined
    const session = await createLocalSSHSession(
      { cwd: '/tmp/project' },
      {
        startProxy: async () => ({
          socketPath: '/tmp/local.sock',
          provider: 'anthropic',
          authKind: 'oauth',
          stop: () => {
            proxyStopped++
          },
        }),
        spawnProcess: (_command, _args, options) => {
          spawnEnv = options.env
          return proc as never
        },
        execPath: '/tmp/claude',
      },
    )

    assert.equal(session.remoteCwd, '/tmp/project')
    assert.equal(session.proc, proc)
    assert.equal(typeof session.createManager, 'function')
    assert.equal(spawnEnv?.ANTHROPIC_BASE_URL, 'http://localhost')

    proc.emit('error', new Error('spawn failed'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(proxyStopped, 1)
  })

  it('does not inherit local credentials into an OpenAI child', async () => {
    const proc = createFakeProcess()
    let spawnEnv: NodeJS.ProcessEnv | undefined
    const previousApiKey = process.env.OPENAI_API_KEY
    const previousAuthToken = process.env.OPENAI_AUTH_TOKEN
    const previousBaseURL = process.env.OPENAI_BASE_URL
    process.env.OPENAI_API_KEY = 'local-api-key'
    process.env.OPENAI_AUTH_TOKEN = 'local-auth-token'
    process.env.OPENAI_BASE_URL = 'https://gateway.example.test'

    try {
      await createLocalSSHSession(
        { cwd: '/tmp/project' },
        {
          startProxy: async () => ({
            socketPath: '/tmp/openai.sock',
            provider: 'openai',
            authKind: 'oauth',
            openAIAuthMode: 'chatgpt',
            stop() {},
          }),
          spawnProcess: (_command, _args, options) => {
            spawnEnv = options.env
            return proc as never
          },
          execPath: '/tmp/claude',
        },
      )

      assert.equal(spawnEnv?.CLAUDE_CODE_USE_OPENAI, '1')
      assert.equal(
        spawnEnv?.CLAUDE_CODE_OPENAI_UNIX_SOCKET,
        '/tmp/openai.sock',
      )
      assert.equal(spawnEnv?.CLAUDE_CODE_OPENAI_AUTH_MODE, 'chatgpt')
      assert.equal(spawnEnv?.OPENAI_API_KEY, undefined)
      assert.equal(spawnEnv?.OPENAI_AUTH_TOKEN, undefined)
      assert.equal(spawnEnv?.OPENAI_BASE_URL, undefined)
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousApiKey
      if (previousAuthToken === undefined) delete process.env.OPENAI_AUTH_TOKEN
      else process.env.OPENAI_AUTH_TOKEN = previousAuthToken
      if (previousBaseURL === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previousBaseURL
    }
  })
})

describe('remote SSH session', () => {
  const probe = {
    platform: 'linux-x64' as const,
    home: '/home/test',
    cwd: '/work',
  }
  const proxy = (stop: () => void = () => {}) => ({
    socketPath: '/tmp/local.sock',
    provider: 'anthropic' as const,
    authKind: 'oauth' as const,
    stop,
  })

  it('stops before deployment when the remote probe fails', async () => {
    let deployCalls = 0
    let proxyCalls = 0
    let spawnCalls = 0

    await assert.rejects(
      createSSHSession(
        { host: 'host.example', localVersion: '1.2.3' },
        {},
        {
          probeRemote: async () => {
            throw new SSHSessionError('probe failed')
          },
          ensureRemoteBinary: async () => {
            deployCalls++
            return '/remote/claude'
          },
          startProxy: async () => {
            proxyCalls++
            return proxy()
          },
          spawnProcess: () => {
            spawnCalls++
            return createFakeProcess() as never
          },
        },
      ),
      /probe failed/,
    )

    assert.equal(deployCalls, 0)
    assert.equal(proxyCalls, 0)
    assert.equal(spawnCalls, 0)
  })

  it('stops before proxy startup when remote deployment fails', async () => {
    let proxyCalls = 0
    let spawnCalls = 0

    await assert.rejects(
      createSSHSession(
        { host: 'host.example', localVersion: '1.2.3' },
        {},
        {
          probeRemote: async () => probe,
          ensureRemoteBinary: async () => {
            throw new SSHSessionError('deploy failed')
          },
          startProxy: async () => {
            proxyCalls++
            return proxy()
          },
          spawnProcess: () => {
            spawnCalls++
            return createFakeProcess() as never
          },
        },
      ),
      /deploy failed/,
    )

    assert.equal(proxyCalls, 0)
    assert.equal(spawnCalls, 0)
  })

  it('cleans up the proxy and remote socket when reverse forwarding fails', async () => {
    const calls: string[] = []

    await assert.rejects(
      createSSHSession(
        { host: 'host.example', localVersion: '1.2.3' },
        {},
        {
          probeRemote: async () => probe,
          ensureRemoteBinary: async () => '/remote/claude',
          startProxy: async () =>
            proxy(() => {
              calls.push('stop')
            }),
          createRemoteSocketDir: () => '/tmp/claude-ssh-test',
          prepareRemoteSocketDirectory: async () => {
            calls.push('prepare')
          },
          spawnProcess: () => {
            calls.push('spawn')
            throw new Error('spawn failed')
          },
          removeRemoteSocketDirectory: async (_connection, path) => {
            calls.push(`remove:${path}`)
          },
        },
      ),
      /Failed to start SSH session to host\.example/,
    )

    assert.deepEqual(calls, [
      'prepare',
      'spawn',
      'stop',
      'remove:/tmp/claude-ssh-test',
    ])
  })

  it('opens reverse forwarding after preparation and cleans up on close', async () => {
    const proc = createFakeProcess()
    const calls: string[] = []
    let spawnedCommand: string | undefined
    let spawnedArgs: string[] | undefined
    const session = await createSSHSession(
      {
        host: 'host.example',
        localVersion: '1.2.3',
        model: 'gateway-model',
      },
      {},
      {
        probeRemote: async () => probe,
        ensureRemoteBinary: async () => '/remote/claude',
        startProxy: async () =>
          proxy(() => {
            calls.push('stop')
          }),
        createRemoteSocketDir: () => '/tmp/claude-ssh-test',
        prepareRemoteSocketDirectory: async () => {
          calls.push('prepare')
        },
        spawnProcess: (command, args) => {
          calls.push('spawn')
          spawnedCommand = command
          spawnedArgs = args
          return proc as never
        },
        removeRemoteSocketDirectory: async (_connection, path) => {
          calls.push(`remove:${path}`)
        },
      },
    )

    assert.equal(session.remoteCwd, '/work')
    assert.equal(spawnedCommand, 'ssh')
    assert.ok(spawnedArgs?.includes('ExitOnForwardFailure=yes'))
    assert.ok(spawnedArgs?.includes('StreamLocalBindUnlink=yes'))
    assert.ok(
      spawnedArgs?.includes(
        '/tmp/claude-ssh-test/api.sock:/tmp/local.sock',
      ),
    )
    assert.deepEqual(calls, ['prepare', 'spawn'])

    proc.emit('close', 0)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, [
      'prepare',
      'spawn',
      'remove:/tmp/claude-ssh-test',
      'stop',
    ])
  })
})

describe('fork remote binary', () => {
  it('uses a target-aware cache and verifies the fork asset checksum', () => {
    const source = readFileSync(
      new URL('./createSSHSession.ts', import.meta.url),
      'utf8',
    )

    assert.match(source, /linux-x64-baseline/)
    assert.match(source, /github\.com\/Esonhugh\/claude-code\/releases/)
    assert.match(source, /SHA256SUMS\.txt/)
    assert.match(
      source,
      /\.cache\/claude-ssh\/\$\{version\}\/\$\{target\}\/claude/,
    )
  })
})
