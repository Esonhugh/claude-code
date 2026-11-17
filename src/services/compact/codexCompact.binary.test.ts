import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// With compact.mode "codex", a session of large Write calls must shrink after
// /compact: the next request carries the user's messages, not the file contents.
// Opt-in because it needs a compiled binary:
//   make build && CLAUDE_COMPACT_BINARY=$PWD/built-claude \
//     bun test src/services/compact/codexCompact.binary.test.ts
const binary = process.env.CLAUDE_COMPACT_BINARY
const WRITES = 30
const FILE_BODY = 'x'.repeat(40_000)

const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const reply = (block: Record<string, unknown>, delta: Record<string, unknown>, stopReason: string) =>
  ev('message_start', {
    message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1 } },
  }) +
  ev('content_block_start', { index: 0, content_block: block }) +
  ev('content_block_delta', { index: 0, delta }) +
  ev('content_block_stop', { index: 0 }) +
  ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }) +
  ev('message_stop', {})
const text = (t: string) => reply({ type: 'text', text: '' }, { type: 'text_delta', text: t }, 'end_turn')
const write = (id: string, input: Record<string, unknown>) =>
  reply({ type: 'tool_use', id, name: 'Write', input: {} }, { type: 'input_json_delta', partial_json: JSON.stringify(input) }, 'tool_use')

describe.skipIf(!binary)('codex-mode /compact after many large Writes (built binary)', () => {
  let api: ReturnType<typeof Bun.serve>
  let home = ''
  let writes = 0
  const requests: { kind: string; body: string }[] = []

  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-compact-')))
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ compact: { mode: 'codex' } }))
    api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({})
        const raw = await req.text()
        const body = JSON.parse(raw) as { messages: { content: unknown }[]; stream?: boolean }
        if (!body.stream) return Response.json({ id: 'msg_x', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
        const last = JSON.stringify(body.messages.at(-1)?.content ?? '')
        let sse: string
        if (last.includes('AFTER')) {
          requests.push({ kind: 'after', body: raw })
          sse = text('ok')
        } else if (/summary/i.test(last)) {
          requests.push({ kind: 'compact', body: raw })
          sse = text('<summary>Wrote the files.</summary>')
        } else if (writes < WRITES) {
          const n = writes++
          sse = write(`toolu_${n}`, { file_path: join(home, `f${n}.txt`), content: FILE_BODY })
        } else {
          requests.push({ kind: 'before', body: raw })
          sse = text('done')
        }
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
  })

  afterAll(() => {
    api?.stop(true)
  })

  it('drops the Write inputs and keeps the user messages', async () => {
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
          if (buf.slice(0, i).includes('"type":"result"')) results.n++
          buf = buf.slice(i + 1)
        }
      }
    })()
    const send = async (content: string) => {
      const before = results.n
      proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }) + '\n')
      proc.stdin.flush()
      while (results.n === before) await Bun.sleep(50)
    }
    await send('WRITE the generated files')
    await send('/compact')
    await send('AFTER compaction, add tests')
    proc.stdin.end()
    await Promise.all([proc.exited, reader])

    expect(writes).toBe(WRITES)
    const before = requests.find(r => r.kind === 'before')!.body
    const after = requests.find(r => r.kind === 'after')!.body
    expect(before).toContain(FILE_BODY)
    expect(after).not.toContain(FILE_BODY.slice(0, 1000))
    expect(after).not.toContain('"tool_use"')
    expect(after).toContain('WRITE the generated files')
    expect(after).toContain('Wrote the files.')
    expect(after.length).toBeLessThan(before.length / 10)
  }, 120_000)
})
