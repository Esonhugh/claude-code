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
  it('rejects local settings flags instead of embedding them in the remote command', () => {
    const forbiddenArgs = [
      ['--settings', '/local/settings.json'],
      ['--settings={"env":{"SSH_CANARY":"local-only"}}'],
      ['--setting-sources', 'user,project'],
      ['--managed-settings', '{"SSH_CANARY":"local-only"}'],
    ]

    for (const extraCliArgs of forbiddenArgs) {
      assert.throws(
        () =>
          buildRemoteLaunchCommand({
            remoteBinaryPath: '/tmp/claude',
            remoteSocketPath: '/tmp/api.sock',
            sshRemoteToken: 'test-ssh-token',
            cwd: '/tmp/project',
            extraCliArgs,
            oauth: true,
          }),
        /local-only option cannot be forwarded to an SSH child/,
      )
    }
  })

  it('configures an OpenAI socket tunnel without embedding credentials', () => {
    const command = buildRemoteLaunchCommand({
      remoteBinaryPath: '/tmp/claude',
      remoteSocketPath: '/tmp/api.sock',
      sshRemoteToken: 'test-ssh-token',
      cwd: '/tmp/project',
      provider: 'openai',
      oauth: true,
    })

    assert.match(command, /CLAUDE_CODE_USE_OPENAI\\=1/)
    assert.match(command, /CLAUDE_CODE_OPENAI_UNIX_SOCKET\\=\/tmp\/api\.sock/)
    assert.match(command, /CLAUDE_CODE_OPENAI_AUTH_MODE\\=chatgpt/)
    assert.match(command, /CLAUDE_CODE_SSH_REMOTE\\=1/)
    assert.match(
      command,
      /CLAUDE_CODE_SSH_REMOTE_TOKEN\\=test-ssh-token/,
    )
    assert.equal(command.includes('OPENAI_API_KEY='), false)
    assert.equal(command.includes('OPENAI_AUTH_TOKEN='), false)
  })

  it('keeps the managed remote child available for explicit mode changes', () => {
    const command = buildRemoteLaunchCommand({
      remoteBinaryPath: '/tmp/claude',
      remoteSocketPath: '/tmp/api.sock',
      sshRemoteToken: 'test-ssh-token',
      cwd: '/tmp/project',
      oauth: true,
    })

    assert.match(command, /--allow-dangerously-skip-permissions/)
  })

  it('forwards the resolved local model to the remote child once', () => {
    const command = buildRemoteLaunchCommand({
      remoteBinaryPath: '/tmp/claude',
      remoteSocketPath: '/tmp/api.sock',
      sshRemoteToken: 'test-ssh-token',
      cwd: '/tmp/project',
      model: 'gateway-model',
      extraCliArgs: ['--tools', 'Read', '--strict-mcp-config'],
      oauth: false,
    })

    assert.match(command, /--model gateway-model/)
    assert.equal(command.match(/--model/g)?.length, 1)
    assert.match(command, /--tools Read --strict-mcp-config/)
  })

  it('quotes paths and forwarded values as POSIX shell arguments', () => {
    const command = buildRemoteLaunchCommand({
      remoteBinaryPath: "/tmp/claude's binary",
      remoteSocketPath: '/tmp/socket path',
      sshRemoteToken: 'test-ssh-token',
      cwd: "/tmp/work dir'quoted",
      permissionMode: 'acceptEdits',
      dangerouslySkipPermissions: true,
      allowDangerouslySkipPermissions: true,
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
    assert.match(command, /--allow-dangerously-skip-permissions/)
    assert.match(command, /'model with spaces; touch \/tmp\/pwned'/)
    assert.equal(command.includes("--model model with spaces; touch"), false)
    assert.equal(command.includes('exec '), false)
  })
})

describe('local SSH session', () => {
  it('forwards the resolved model and extracted root flags to the local child', async () => {
    const proc = createFakeProcess()
    let spawnArgs: string[] = []

    await createLocalSSHSession(
      {
        cwd: '/tmp/project',
        model: 'gateway-model',
        extraCliArgs: ['--continue', '--resume', 'session-id'],
      },
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

    assert.deepEqual(spawnArgs.slice(-5), [
      '--model',
      'gateway-model',
      '--continue',
      '--resume',
      'session-id',
    ])
  })

  it('returns a usable session and stops the proxy if child startup fails', async () => {
    const proc = createFakeProcess()
    let proxyStopped = 0
    let spawnEnv: NodeJS.ProcessEnv | undefined
    const session = await createLocalSSHSession(
      { cwd: '/tmp/project', target: 'local-test' },
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
    assert.equal(session.target, 'local-test')
    assert.match(session.sshRemoteToken ?? '', /^[0-9a-f]{64}$/)
    assert.equal(session.proc, proc)
    assert.equal(typeof session.createManager, 'function')
    assert.equal(spawnEnv?.ANTHROPIC_BASE_URL, 'http://localhost')
    assert.equal(spawnEnv?.CLAUDE_CODE_SSH_REMOTE, '1')
    assert.equal(
      spawnEnv?.CLAUDE_CODE_SSH_REMOTE_TOKEN,
      session.sshRemoteToken,
    )

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
    const previousCustomHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS
    const previousClientKeyPassphrase =
      process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE
    process.env.OPENAI_API_KEY = 'local-api-key'
    process.env.OPENAI_AUTH_TOKEN = 'local-auth-token'
    process.env.OPENAI_BASE_URL = 'https://gateway.example.test'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-local: secret'
    process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE = 'local-passphrase'

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
      assert.equal(spawnEnv?.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, '1')
      assert.equal(spawnEnv?.CLAUDE_CODE_SSH_REMOTE, '1')
      assert.match(spawnEnv?.CLAUDE_CODE_SSH_REMOTE_TOKEN ?? '', /^[0-9a-f]{64}$/)
      assert.equal(spawnEnv?.OPENAI_API_KEY, undefined)
      assert.equal(spawnEnv?.OPENAI_AUTH_TOKEN, undefined)
      assert.equal(spawnEnv?.OPENAI_BASE_URL, undefined)
      assert.equal(spawnEnv?.ANTHROPIC_CUSTOM_HEADERS, undefined)
      assert.equal(spawnEnv?.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE, undefined)
    } finally {
      if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousApiKey
      if (previousAuthToken === undefined) delete process.env.OPENAI_AUTH_TOKEN
      else process.env.OPENAI_AUTH_TOKEN = previousAuthToken
      if (previousBaseURL === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previousBaseURL
      if (previousCustomHeaders === undefined) {
        delete process.env.ANTHROPIC_CUSTOM_HEADERS
      } else {
        process.env.ANTHROPIC_CUSTOM_HEADERS = previousCustomHeaders
      }
      if (previousClientKeyPassphrase === undefined) {
        delete process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE
      } else {
        process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE =
          previousClientKeyPassphrase
      }
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
    let controlStopCalls = 0

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
          stopControlMaster: async () => {
            controlStopCalls++
          },
        },
      ),
      /probe failed/,
    )

    assert.equal(deployCalls, 0)
    assert.equal(proxyCalls, 0)
    assert.equal(spawnCalls, 0)
    assert.equal(controlStopCalls, 1)
  })

  it('stops before proxy startup when remote deployment fails', async () => {
    let proxyCalls = 0
    let spawnCalls = 0
    let controlStopCalls = 0

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
          stopControlMaster: async () => {
            controlStopCalls++
          },
        },
      ),
      /deploy failed/,
    )

    assert.equal(proxyCalls, 0)
    assert.equal(spawnCalls, 0)
    assert.equal(controlStopCalls, 1)
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
          stopControlMaster: async () => {
            calls.push('stop-control')
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
      'stop-control',
    ])
  })

  it('stops the control master when startup cleanup fails', async () => {
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
          prepareRemoteSocketDirectory: async () => {},
          spawnProcess: () => {
            throw new Error('spawn failed')
          },
          removeRemoteSocketDirectory: async () => {
            calls.push('remove')
            throw new Error('cleanup failed')
          },
          stopControlMaster: async () => {
            calls.push('stop-control')
          },
        },
      ),
      /cleanup failed/,
    )

    assert.deepEqual(calls, ['stop', 'remove', 'stop-control'])
  })

  it('opens reverse forwarding after preparation and cleans up on close', async () => {
    const proc = createFakeProcess()
    const calls: string[] = []
    let registeredCleanup: (() => Promise<void>) | undefined
    let unregisterCalls = 0
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
        stopControlMaster: async () => {
          calls.push('stop-control')
        },
        registerCleanup: cleanup => {
          registeredCleanup = cleanup
          return () => {
            unregisterCalls++
          }
        },
      },
    )

    assert.equal(session.remoteCwd, '/work')
    assert.equal(session.target, 'host.example')
    assert.match(session.sshRemoteToken ?? '', /^[0-9a-f]{64}$/)
    assert.ok(
      spawnedArgs
        ?.at(-1)
        ?.includes(
          `CLAUDE_CODE_SSH_REMOTE_TOKEN\\=${session.sshRemoteToken}`,
        ),
    )
    assert.equal(spawnedCommand, 'ssh')
    const controlPathArg = spawnedArgs?.find(arg => arg.startsWith('ControlPath='))
    assert.match(
      controlPathArg ?? '',
      /^ControlPath=.*[/\\]cc-ssh-[0-9a-f]{24}$/,
    )
    assert.ok(
      Buffer.byteLength(controlPathArg?.slice('ControlPath='.length) ?? '') < 104,
    )
    assert.ok(spawnedArgs?.includes('ExitOnForwardFailure=yes'))
    assert.ok(spawnedArgs?.includes('StreamLocalBindUnlink=yes'))
    assert.ok(
      spawnedArgs?.includes(
        '/tmp/claude-ssh-test/api.sock:/tmp/local.sock',
      ),
    )
    assert.deepEqual(calls, ['prepare', 'spawn'])
    assert.equal(typeof registeredCleanup, 'function')

    await registeredCleanup?.()
    assert.deepEqual(calls, [
      'prepare',
      'spawn',
      'remove:/tmp/claude-ssh-test',
      'stop',
      'stop-control',
    ])
    assert.equal(unregisterCalls, 1)

    proc.emit('close', 0)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(unregisterCalls, 1)
  })

  it('stops the proxy and control master when remote socket cleanup fails', async () => {
    const proc = createFakeProcess()
    const calls: string[] = []
    let registeredCleanup: (() => Promise<void>) | undefined
    let unregisterCalls = 0

    await createSSHSession(
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
        prepareRemoteSocketDirectory: async () => {},
        spawnProcess: () => proc as never,
        removeRemoteSocketDirectory: async () => {
          calls.push('remove')
          throw new Error('cleanup failed')
        },
        stopControlMaster: async () => {
          calls.push('stop-control')
        },
        registerCleanup: cleanup => {
          registeredCleanup = cleanup
          return () => {
            unregisterCalls++
          }
        },
      },
    )

    await assert.rejects(registeredCleanup?.(), /cleanup failed/)
    assert.deepEqual(calls, ['remove', 'stop', 'stop-control'])
    assert.equal(unregisterCalls, 1)
  })
})

describe('fork remote binary', () => {
  it('allows slow SSH authentication to complete before timing out commands', () => {
    const source = readFileSync(
      new URL('./createSSHSession.ts', import.meta.url),
      'utf8',
    )

    assert.match(source, /const SSH_COMMAND_TIMEOUT_MS = 2 \* 60_000/)
    assert.match(source, /timeout = SSH_COMMAND_TIMEOUT_MS/)
    assert.match(source, /'ConnectTimeout=30'/)
    assert.match(source, /'ConnectionAttempts=3'/)
  })

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

  it('does not install an incomplete upload and retries transient deployment failures', () => {
    const source = readFileSync(
      new URL('./createSSHSession.ts', import.meta.url),
      'utf8',
    )

    assert.match(source, /const SSH_DEPLOY_ATTEMPTS = 3/)
    assert.match(source, /ControlMaster=auto/)
    assert.match(source, /ControlPersist=10m/)
    assert.match(source, /const SSH_DEPLOY_CHUNK_SIZE = 2 \* 1024 \* 1024/)
    assert.match(
      source,
      /\[\.\.\.baseSSHArgs\(connection\), '--', connection\.host, command\]/,
    )
    assert.match(source, /const chunkChecksum = createHash\('sha256'\)/)
    assert.match(source, /proc\.stdin!\.end\(buffer\)/)
    assert.match(source, /sha256sum "\$chunk"/)
    assert.match(source, /cat "\$chunk" >>/)
    assert.match(source, /sha256sum \$\{quote\(\[temporary\]\)\}/)
    assert.match(source, /test "\$actual" = "\$expected"/)
    assert.match(
      source,
      /for \(let attempt = 1; attempt <= SSH_DEPLOY_ATTEMPTS; attempt\+\+\)/,
    )
  })

  it('logs deployment and login lifecycle without credentials', () => {
    const source = readFileSync(
      new URL('./createSSHSession.ts', import.meta.url),
      'utf8',
    )

    assert.match(source, /\[SSH\] probe start/)
    assert.match(source, /\[SSH\] deploy chunk start/)
    assert.match(source, /\[SSH\] remote child spawn start/)
    assert.match(source, /sshRemote=true bypass=/)
    assert.match(source, /\[SSH\] session ready/)
    assert.match(source, /\[SSH\] control master stop/)
  })
})
