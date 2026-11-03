import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A stream-json session that runs /compact and later auto-compacts must not
// write the messages from before the first compaction into its transcript again.
// Opt-in because it needs a compiled binary:
//   make build && CLAUDE_COMPACT_BINARY=$PWD/built-claude \
//     bun test src/services/compact/headlessCompactTranscript.binary.test.ts
const binary = process.env.CLAUDE_COMPACT_BINARY

const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const sse = (text: string, inputTokens: number) =>
  ev('message_start', {
    message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } },
  }) +
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
  ev('content_block_stop', { index: 0 }) +
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) +
  ev('message_stop', {})

describe.skipIf(!binary)('compaction in a stream-json session (built binary)', () => {
  let api: ReturnType<typeof Bun.serve>
  let home = ''

  beforeAll(() => {
    api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({})
        const body = (await req.json()) as { messages: { content: unknown }[]; stream?: boolean }
        const last = JSON.stringify(body.messages.at(-1)?.content ?? '')
        // A reply to BIG reports a nearly full context, so the next turn auto-compacts.
        const tokens = last.includes('BIG') ? 985_000 : 100
        if (!body.stream) return Response.json({ id: 'msg_x', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
        return new Response(sse('Summary or reply.', tokens), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    home = realpathSync(mkdtempSync(join(tmpdir(), 'compact-transcript-')))
  })

  afterAll(() => {
    api?.stop(true)
  })

  it('records each message once across a /compact and an auto-compact', async () => {
    const proc = Bun.spawn(
      [binary!, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          IS_SANDBOX: '1',
          ANTHROPIC_API_KEY: 'sk-fake',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const lines: string[] = []
    const results = { n: 0 }
    const reader = (async () => {
      const decoder = new TextDecoder()
      let buf = ''
      const stdout = proc.stdout.getReader()
      for (;;) {
        const { done, value } = await stdout.read()
        if (done) break
        buf += decoder.decode(value)
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          lines.push(line)
          if (line.includes('"type":"result"')) results.n++
        }
      }
    })()
    const send = async (text: string) => {
      const before = results.n
      proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) + '\n')
      proc.stdin.flush()
      while (results.n === before) await Bun.sleep(50)
    }
    await send('first question')
    await send('/compact')
    await send('BIG context')
    await send('after the auto-compact')
    proc.stdin.end()
    await Promise.all([proc.exited, reader])

    const boundaries = lines.filter(l => l.includes('"subtype":"compact_boundary"'))
    expect(boundaries.length).toBe(2)
    const dir = join(home, '.claude', 'projects')
    const [project] = readdirSync(dir)
    const [file] = readdirSync(join(dir, project!)).filter(f => f.endsWith('.jsonl'))
    const uuids = readFileSync(join(dir, project!, file!), 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as { uuid?: string; type: string })
      .filter(e => e.uuid && ['user', 'assistant', 'attachment', 'system'].includes(e.type))
      .map(e => e.uuid!)
    expect(uuids.filter((u, i) => uuids.indexOf(u) !== i)).toEqual([])
  }, 90_000)
})
