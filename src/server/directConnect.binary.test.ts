import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// End-to-end check of a built binary: `claude server` spawning real
// `claude -p` sessions against a scripted Messages API, driven by
// `claude cc://… -p`. Opt-in because it needs a compiled binary:
//   make build && CLAUDE_DIRECT_CONNECT_BINARY=$PWD/built-claude \
//     bun test src/server/directConnect.binary.test.ts
const binary = process.env.CLAUDE_DIRECT_CONNECT_BINARY
const TOKEN = 'binary-test-token'

const sse = (blocks: Record<string, unknown>[], stop: string) => {
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  let out = ev('message_start', {
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: 'fake',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      out += ev('content_block_start', {
        index,
        content_block: { type: 'text', text: '' },
      })
      out += ev('content_block_delta', {
        index,
        delta: { type: 'text_delta', text: block.text },
      })
    } else {
      out += ev('content_block_start', {
        index,
        content_block: { ...block, input: {} },
      })
      out += ev('content_block_delta', {
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input),
        },
      })
    }
    out += ev('content_block_stop', { index })
  })
  out += ev('message_delta', {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 1 },
  })
  return out + ev('message_stop', {})
}

describe.skipIf(!binary)('claude server + cc:// client (built binary)', () => {
  const toolResults: string[] = []
  let api: ReturnType<typeof Bun.serve>
  let server: ReturnType<typeof Bun.spawn>
  let connectUrl = ''
  let home = ''
  let project = ''
  let env: Record<string, string> = {}

  beforeAll(async () => {
    // A prompt containing TOUCH asks for `touch made.txt`; once a tool_result
    // comes back the turn ends with REMOTE_DONE.
    api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/messages')) {
          return Response.json({})
        }
        type Block = { type: string; content?: unknown }
        const body = (await req.json()) as {
          messages: { content: string | Block[] }[]
        }
        const blocksOf = (content: string | Block[]) =>
          typeof content === 'string' ? [] : content
        const result = body.messages
          .flatMap(m => blocksOf(m.content))
          .find(b => b.type === 'tool_result')
        let blocks: Record<string, unknown>[] = [
          { type: 'text', text: 'REMOTE_DONE' },
        ]
        let stop = 'end_turn'
        if (result) {
          toolResults.push(JSON.stringify(result.content))
        } else if (JSON.stringify(body.messages).includes('TOUCH')) {
          blocks = [
            {
              type: 'tool_use',
              id: `toolu_${toolResults.length}`,
              name: 'Bash',
              input: { command: 'touch made.txt' },
            },
          ]
          stop = 'tool_use'
        }
        return new Response(sse(blocks, stop), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })

    home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-bin-home-')))
    project = join(home, 'project')
    mkdirSync(project)
    env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      IS_SANDBOX: '1',
      ANTHROPIC_API_KEY: 'sk-fake',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    }
    server = Bun.spawn(
      [binary!, 'server', '--port', '0', '--auth-token', TOKEN],
      { cwd: project, env, stdout: 'pipe', stderr: 'pipe' },
    )
    const reader = (server.stdout as ReadableStream<Uint8Array>).getReader()
    let banner = ''
    while (!/cc:\/\/\S+/.test(banner)) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`server exited early: ${banner}`)
      banner += new TextDecoder().decode(value)
    }
    reader.releaseLock()
    connectUrl = /cc:\/\/\S+/.exec(banner)![0]
  }, 30_000)

  afterAll(() => {
    server?.kill('SIGKILL')
    api?.stop(true)
  })

  const connect = async (...args: string[]) => {
    const proc = Bun.spawn([binary!, connectUrl, ...args], {
      cwd: project,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  }

  it('prints the banner with a loopback cc:// URL and writes the lock', () => {
    expect(connectUrl).toMatch(
      new RegExp(`^cc://127\\.0\\.0\\.1:\\d+/${TOKEN}$`),
    )
    expect(existsSync(join(home, '.claude', 'server.lock'))).toBe(true)
  })

  it('denies tool use from headless -p without --dangerously-skip-permissions', async () => {
    const run = await connect('-p', 'TOUCH')
    expect(run).toMatchObject({ code: 0, stdout: 'REMOTE_DONE\n' })
    expect(toolResults.at(-1)).toContain('headless direct-connect cannot prompt')
    expect(existsSync(join(project, 'made.txt'))).toBe(false)
  }, 60_000)

  it('allows tool use with --dangerously-skip-permissions and streams JSON', async () => {
    const run = await connect(
      '-p',
      'TOUCH',
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
    )
    expect(run.code).toBe(0)
    const types = run.stdout
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { type: string }).type)
    expect(types).toContain('assistant')
    expect(types.at(-1)).toBe('result')
    expect(existsSync(join(project, 'made.txt'))).toBe(true)
  }, 60_000)

  it('rejects a wrong token with the server response body', async () => {
    const proc = Bun.spawn(
      [binary!, connectUrl.replace(TOKEN, 'wrong'), '-p', 'hi'],
      { cwd: project, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    )
    const stderr = await new Response(proc.stderr as ReadableStream).text()
    expect(await proc.exited).toBe(1)
    expect(stderr).toContain('401 Unauthorized')
  }, 30_000)

  it('stops on Ctrl+C from a terminal and removes the lock', async () => {
    // `script` gives the server a pty, so ^C on stdin goes through the line
    // discipline: it only becomes SIGINT if the server restored cooked mode.
    const ptyHome = realpathSync(mkdtempSync(join(tmpdir(), 'dc-bin-pty-')))
    const proc = Bun.spawn(
      [
        'script',
        '-qefc',
        // exec: otherwise the intermediate sh reports the SIGINT as 130.
        `exec ${binary} server --port 0 --auth-token ${TOKEN}`,
        '/dev/null',
      ],
      {
        cwd: project,
        env: { ...env, HOME: ptyHome },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    let output = ''
    while (!output.includes('Press Ctrl+C to stop')) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`server exited early: ${output}`)
      output += new TextDecoder().decode(value)
    }
    expect(existsSync(join(ptyHome, '.claude', 'server.lock'))).toBe(true)

    proc.stdin.write('\x03')
    proc.stdin.flush()
    expect(await proc.exited).toBe(0)
    expect(existsSync(join(ptyHome, '.claude', 'server.lock'))).toBe(false)
  }, 30_000)

  it('shuts down on SIGTERM (exit 143 like the rest of the CLI) and removes the lock', async () => {
    server.kill('SIGTERM')
    expect(await server.exited).toBe(143)
    expect(existsSync(join(home, '.claude', 'server.lock'))).toBe(false)
  }, 30_000)
})
