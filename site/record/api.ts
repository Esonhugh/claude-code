// Scripted Messages API for the recordings: it plays the model's side, while the real CLI renders
// the UI and runs every tool for real in the fixture project.

export type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown }
export type Message = { role: string; content: string | { type: string; text?: string; content?: unknown }[] }
export type Request = { stream?: boolean; tools?: unknown[]; system?: unknown; model: string; messages: Message[] }

// What the scene sees for each main-loop request: how many assistant turns came before, and the text
// of the latest tool result (e.g. to reuse a pane id the CLI handed back). `first` is the text of the
// conversation's first user message, which tells the lead's loop apart from a teammate's or a peer's.
export type Turn = { turn: number; lastResult: string; first: string; body: Request }

export type Script = {
  steps: (t: Turn) => Block[]
  // Requests without tools: compaction, hook evaluators, titles.
  side?: (body: Request, system: string) => string | undefined
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const usage = { input_tokens: 3200, output_tokens: 180, cache_read_input_tokens: 9100, cache_creation_input_tokens: 0 }

function messageText(m: Message | undefined): string {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  return m.content.map(b => b.text ?? '').join('\n')
}

function resultText(messages: Message[]): string {
  const last = messages.at(-1)
  if (!last || typeof last.content === 'string') return ''
  const out: string[] = []
  for (const block of last.content) {
    if (block.type !== 'tool_result') continue
    if (typeof block.content === 'string') out.push(block.content)
    else if (Array.isArray(block.content)) for (const c of block.content as { text?: string }[]) if (c.text) out.push(c.text)
  }
  return out.join('\n')
}

export function serveScript(port: number, script: Script) {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({})
      const body = (await req.json()) as Request
      if (!body.tools?.length) {
        const text = script.side?.(body, JSON.stringify(body.system ?? '')) ?? 'Demo session'
        if (body.stream === true) return sse(body.model, [{ type: 'text', text }], 300)
        return Response.json({ id: 'msg_side', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage })
      }
      const turn = body.messages.filter(m => m.role === 'assistant').length
      const blocks = script.steps({ turn, lastResult: resultText(body.messages), first: messageText(body.messages.find(m => m.role === 'user')), body })
      return sse(body.model, blocks, turn === 0 ? 1500 : 700)
    },
  })
}

function sse(model: string, blocks: Block[], delay: number) {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(c) {
        const send = (event: string, data: object) => c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`))
        send('message_start', { message: { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } } })
        await sleep(delay)
        for (const [index, b] of blocks.entries()) {
          if (b.type === 'text') {
            send('content_block_start', { index, content_block: { type: 'text', text: '' } })
            for (let i = 0; i < b.text.length; i += 6) {
              send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(i, i + 6) } })
              await sleep(35)
            }
          } else {
            send('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${crypto.randomUUID().slice(0, 8)}`, name: b.name, input: {} } })
            send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
            await sleep(300)
          }
          send('content_block_stop', { index })
        }
        const stop = blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
        send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 180 } })
        send('message_stop', {})
        c.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
