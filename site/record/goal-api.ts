// Scripted Messages API for the goal recording: it plays the model's side, while the real CLI renders
// the UI and runs Bash/Read/Edit for real in the fixture project.
import type { Lang } from '../src/demos/i18n'

type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown }

export function goalSteps(lang: Lang, dir: string): Block[][] {
  const L = (en: string, zh: string, hans: string) => ({ en, zh, hans })[lang]
  const file = `${dir}/src/parser.ts`
  const test = { type: 'tool_use', name: 'Bash', input: { command: 'bun test', description: 'Run the test suite' } } as const
  return [
    [
      { type: 'text', text: L("I'll set a goal so I keep going until the whole suite is green.", '我先設定目標，持續修到整個測試套件全綠為止。', '我先设定目标，持续修到整个测试套件全绿为止。') },
      { type: 'tool_use', name: 'Goal', input: { action: 'set', goal: 'every test in `bun test` passes' } },
    ],
    [test],
    [{ type: 'tool_use', name: 'Read', input: { file_path: file } }],
    [
      { type: 'text', text: L('`-dog` is parsed as a term. Routing `-` prefixed words to `exclude`.', '`-dog` 被當成一般詞。把 `-` 開頭的詞改放進 `exclude`。', '`-dog` 被当成普通词。把 `-` 开头的词改放进 `exclude`。') },
      {
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: file, old_string: '    else q.terms.push(m[2])', new_string: "    else if (m[2].startsWith('-')) q.exclude.push(m[2].slice(1))\n    else q.terms.push(m[2])" },
      },
    ],
    [test],
    // Ends the turn early on purpose, so the Goal stop hook sends Claude back to work.
    [{ type: 'text', text: L('Fixed `-term` exclusion; both exclude tests pass now.', '`-term` 排除已修好，兩個 exclude 測試都通過了。', '`-term` 排除已修好，两个 exclude 测试都通过了。') }],
    [
      { type: 'text', text: L('One test is still red: terms must be lowercased.', '還有一個沒過：詞要轉成小寫。', '还有一个没过：词要转成小写。') },
      { type: 'tool_use', name: 'Edit', input: { file_path: file, old_string: '    else q.terms.push(m[2])', new_string: '    else q.terms.push(m[2].toLowerCase())' } },
    ],
    [test],
    [{ type: 'text', text: L('All 6 tests pass: `-term` exclusion and lowercasing are fixed in `src/parser.ts`.', '6 個測試全部通過：`src/parser.ts` 修好了 `-term` 排除和小寫轉換。', '6 个测试全部通过：`src/parser.ts` 修好了 `-term` 排除和小写转换。') }],
  ]
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const usage = { input_tokens: 3200, output_tokens: 180, cache_read_input_tokens: 9100, cache_creation_input_tokens: 0 }

export function serveGoalApi(port: number, steps: Block[][]) {
  let hookCalls = 0
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/messages')) return Response.json({})
      const body = (await req.json()) as { stream?: boolean; tools?: unknown[]; system?: unknown; model: string; messages: { role: string }[] }
      if (body.stream !== true || !body.tools?.length) {
        // Side queries: the Goal stop-hook evaluator fails once, then passes; anything else gets a title.
        let text = 'Fix parser tests'
        if (JSON.stringify(body.system ?? '').includes('stop-condition hook')) {
          hookCalls++
          text = JSON.stringify(hookCalls === 1 ? { ok: false, reason: '1 test still fails: lowercases terms' } : { ok: true, reason: '6 pass, 0 fail' })
        }
        if (body.stream === true) return sse(body.model, [{ type: 'text', text }], 0)
        return Response.json({ id: 'msg_side', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage })
      }
      const turn = body.messages.filter(m => m.role === 'assistant').length
      return sse(body.model, steps[Math.min(turn, steps.length - 1)], turn === 0 ? 1500 : 700)
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
