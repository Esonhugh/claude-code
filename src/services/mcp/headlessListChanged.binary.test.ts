import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// `claude -p` must pick up an MCP server's tools/list_changed within one run.
// Opt-in because it needs a compiled binary:
//   make build && CLAUDE_HEADLESS_MCP_BINARY=$PWD/built-claude \
//     bun test src/services/mcp/headlessListChanged.binary.test.ts
const binary = process.env.CLAUDE_HEADLESS_MCP_BINARY

// Lists alpha + gamma; after the first alpha call it lists alpha + beta and
// sends notifications/tools/list_changed.
const MCP_SERVER = `
let changed = false
const tool = name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })
const send = o => process.stdout.write(JSON.stringify(o) + '\\n')
let buf = ''
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 't', version: '1' } } })
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [tool('alpha'), tool(changed ? 'beta' : 'gamma')] } })
    else if (m.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.name }] } })
      if (!changed) { changed = true; send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) }
    } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
  }
})
`

const sse = (block: Record<string, unknown>, stop: string) => {
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const start =
    block.type === 'text'
      ? { type: 'text', text: '' }
      : { ...block, input: {} }
  const delta =
    block.type === 'text'
      ? { type: 'text_delta', text: block.text }
      : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
  return (
    ev('message_start', {
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'fake',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }) +
    ev('content_block_start', { index: 0, content_block: start }) +
    ev('content_block_delta', { index: 0, delta }) +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    ev('message_stop', {})
  )
}

describe.skipIf(!binary)('headless MCP tools/list_changed (built binary)', () => {
  const toolNamesPerRequest: string[][] = []
  let api: ReturnType<typeof Bun.serve>
  let home = ''

  beforeAll(() => {
    // Calls alpha twice, then ends the turn. Other requests (side queries) get text.
    api = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith('/messages')) {
          return Response.json({})
        }
        const body = (await req.json()) as {
          tools?: { name: string }[]
          messages: unknown[]
        }
        if (!JSON.stringify(body.messages).includes('LIST_CHANGED')) {
          return new Response(sse({ type: 'text', text: 'side' }, 'end_turn'), {
            headers: { 'content-type': 'text/event-stream' },
          })
        }
        toolNamesPerRequest.push((body.tools ?? []).map(tool => tool.name))
        const turn = JSON.stringify(body.messages).split('"tool_result"').length - 1
        const block =
          turn < 2
            ? {
                type: 'tool_use',
                id: `toolu_${turn}`,
                name: 'mcp__t__alpha',
                input: {},
              }
            : { type: 'text', text: 'DONE' }
        return new Response(
          sse(block, block.type === 'text' ? 'end_turn' : 'tool_use'),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-list-changed-')))
    writeFileSync(join(home, 'server.js'), MCP_SERVER)
    writeFileSync(
      join(home, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          t: { command: process.execPath, args: [join(home, 'server.js')] },
        },
      }),
    )
  })

  afterAll(() => {
    api?.stop(true)
  })

  it('later requests in the same run list the new tools and drop the removed ones', async () => {
    const proc = Bun.spawn(
      [
        binary!,
        '-p',
        'LIST_CHANGED',
        '--mcp-config',
        join(home, 'mcp.json'),
        '--dangerously-skip-permissions',
      ],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          IS_SANDBOX: '1',
          ANTHROPIC_API_KEY: 'sk-fake',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
          ENABLE_TOOL_SEARCH: 'false',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      proc.exited,
    ])
    expect({ code, stdout }).toEqual({ code: 0, stdout: 'DONE\n' })
    expect(toolNamesPerRequest[0]).toContain('mcp__t__gamma')
    expect(toolNamesPerRequest.at(-1)).toContain('mcp__t__beta')
    expect(toolNamesPerRequest.at(-1)).not.toContain('mcp__t__gamma')
  }, 60_000)
})
