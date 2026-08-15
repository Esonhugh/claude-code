import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, it } from 'bun:test'
import {
  buildRemoteLaunchCommand,
  createLocalSSHSession,
  resolveSSHConnection,
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

  it('prepares the socket directory before opening reverse forwarding', () => {
    const source = readFileSync(new URL('./createSSHSession.ts', import.meta.url), 'utf8')
    const prepareIndex = source.indexOf(
      'await prepareRemoteSocketDirectory(connection, remoteSocketDir)',
    )
    const spawnIndex = source.indexOf("const proc = spawn(\n      'ssh',")

    assert.notEqual(prepareIndex, -1)
    assert.notEqual(spawnIndex, -1)
    assert.ok(prepareIndex < spawnIndex)
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
