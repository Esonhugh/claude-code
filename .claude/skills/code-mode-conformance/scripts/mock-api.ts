// Scenario-driven fake Messages API for Code Mode conformance runs (L2/L3).
//
// Main-thread user turns look like "@@ <nonce> <CMD>". The reply is
// scenario.commands[CMD][step], where step counts tool_results since that
// turn (the last entry repeats), leaving out the `poll_` results of spliced
// Poll deliveries, so that step 1 still means "after the first tool call".
// A turn woken by a notification uses commands["<CMD>:notif"] or
// "NOTIF <nonce>"; one woken by a poll event (the last user message holds only
// `poll_` results) uses commands["<CMD>:wake"] or "WAKE <nonce>". Subagents (first message has no
// "@@") match scenario.agents by regex on their first message; requests with
// no tools (titles, compaction) match scenario.side, else answer "ok".
//
// Templates in reply text and tool inputs: {{nonce}}, {{work}}, {{last}}
// (last tool_result text, whitespace collapsed, first 300 chars).
//
// Every request is appended, redacted, to MOCK_JSONL; MOCK_DUMP=<dir> also
// writes each redacted body. Binds 127.0.0.1 only.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'

export type ToolCall = { name: string; input: unknown }
export type Reply = { text?: string; tools?: ToolCall[]; status?: number; delayMs?: number }
export type Scenario = {
  name: string
  commands?: Record<string, Reply[]>
  agents?: Record<string, Reply[]>
  side?: { match: string; text: string }[]
}
export type Decision = { role: string; cmd?: string; step: number; reply: Reply; nonce?: string }

const SECRET_KEYS = /^(authorization|x-api-key|cookie|set-cookie|api[_-]?key|proxy-authorization)$/i
const SECRET_VALUES = [/sk-ant-[A-Za-z0-9_-]+/g, /Bearer\s+[A-Za-z0-9._~+/=-]+/g]

/** Deep copy with secret-named keys and token-shaped strings replaced. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return SECRET_VALUES.reduce((s, re) => s.replace(re, '[REDACTED]'), value)
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : redact(v)
    return out
  }
  return value
}

export const text = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b: any) => b?.text ?? (b?.content !== undefined ? text(b.content) : '')).join('\n')
      : ''

/** A user message's own text, without tool_result blocks: the client merges a typed prompt into the result message. */
const ownText = (m: any): string =>
  Array.isArray(m?.content) ? text(m.content.filter((b: any) => b?.type !== 'tool_result')) : text(m?.content)
export const toolResults = (msgs: any[]): any[] =>
  msgs.flatMap((m: any) => (Array.isArray(m?.content) ? m.content.filter((b: any) => b?.type === 'tool_result') : []))
/** A spliced Poll delivery (official `poll_<attachment uuid>`), not a tool call the model made. */
const isPollSplice = (b: any): boolean => typeof b?.tool_use_id === 'string' && b.tool_use_id.startsWith('poll_')
/** The tool results a step counts: the model's own tool calls. */
export const stepResults = (msgs: any[]): any[] => toolResults(msgs).filter(b => !isPollSplice(b))
const CMD = /^@@ (\S+) ([A-Z][A-Z0-9_]*)\b/m

function pick(list: Reply[] | undefined, step: number): Reply | undefined {
  if (!list || list.length === 0) return undefined
  return list[Math.min(step, list.length - 1)]
}

export function fill<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m) as T
  if (Array.isArray(value)) return value.map(v => fill(v, vars)) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)])) as T
  return value
}
/** Pick the reply for one request body. Pure, so tests can drive it. */
export function decide(body: any, scenario: Scenario, work = '/tmp'): Decision {
  const msgs: any[] = body?.messages ?? []
  const tools: any[] = body?.tools ?? []
  const lastResultText = (list: any[]) =>
    text(toolResults(list).at(-1)?.content ?? '').replace(/\s+/g, ' ').slice(0, 300)
  const vars = (nonce: string, list: any[]) => ({ nonce, work, last: lastResultText(list) })

  if (tools.length === 0) {
    const all = msgs.map(m => text(m.content)).join('\n')
    const rule = (scenario.side ?? []).find(r => new RegExp(r.match).test(all))
    return { role: 'side', step: 0, reply: { text: rule?.text ?? 'ok' } }
  }
  const first = text(msgs[0]?.content)
  if (!msgs.some(m => m.role === 'user' && CMD.test(ownText(m)))) {
    const steps = stepResults(msgs).length
    for (const [key, list] of Object.entries(scenario.agents ?? {})) {
      if (new RegExp(key).test(first)) {
        const reply = pick(list, steps)!
        return { role: `agent:${key}`, step: steps, reply: fill(reply, vars('', msgs)) }
      }
    }
    return { role: 'agent:none', step: steps, reply: { text: 'agent ok' } }
  }
  let idx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user' && CMD.test(ownText(msgs[i]))) {
      idx = i
      break
    }
  }
  const [, nonce, cmd] = ownText(msgs[idx]).match(CMD)!
  const tail = msgs.slice(idx + 1)
  const step = stepResults(tail).length
  const last = msgs[msgs.length - 1]
  if (idx !== msgs.length - 1 && last?.role === 'user' && ownText(last).trim() !== '') {
    const reply = pick(scenario.commands?.[`${cmd}:notif`], 0) ?? { text: 'NOTIF {{nonce}}' }
    return { role: `main:${cmd}:notif`, cmd, step, nonce, reply: fill(reply, vars(nonce, tail)) }
  }
  const lastResults = last?.role === 'user' ? toolResults([last]) : []
  if (idx !== msgs.length - 1 && lastResults.length > 0 && lastResults.every(isPollSplice)) {
    const reply = pick(scenario.commands?.[`${cmd}:wake`], 0) ?? { text: 'WAKE {{nonce}}' }
    return { role: `main:${cmd}:wake`, cmd, step, nonce, reply: fill(reply, vars(nonce, tail)) }
  }
  const reply = pick(scenario.commands?.[cmd], step) ?? { text: 'DONE {{nonce}} unknown-command' }
  return { role: `main:${cmd}`, cmd, step, nonce, reply: fill(reply, vars(nonce, tail)) }
}

let ids = 0
const id = (p: string) => `${p}_mock${(++ids).toString(36).padStart(6, '0')}`

/** Anthropic streaming events for one reply. */
export function sse(reply: Reply, model: string): string {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const usage = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  let out = ev('message_start', {
    message: { id: id('msg'), type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage },
  })
  const blocks = reply.tools?.length ? reply.tools : null
  if (!blocks) {
    out += ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    out += ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text ?? '' } })
    out += ev('content_block_stop', { index: 0 })
  } else {
    blocks.forEach((t, i) => {
      out += ev('content_block_start', {
        index: i,
        content_block: { type: 'tool_use', id: id('toolu'), name: t.name, input: {} },
      })
      out += ev('content_block_delta', {
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) },
      })
      out += ev('content_block_stop', { index: i })
    })
  }
  out += ev('message_delta', {
    delta: { stop_reason: blocks ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  })
  return out + ev('message_stop', {})
}

/** The non-streaming form of the same reply. */
export function message(reply: Reply, model: string): object {
  const content = reply.tools?.length
    ? reply.tools.map(t => ({ type: 'tool_use', id: id('toolu'), name: t.name, input: t.input }))
    : [{ type: 'text', text: reply.text ?? '' }]
  return {
    id: id('msg'),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: reply.tools?.length ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  }
}
/** One JSONL record per request: routing, tool names, system hash, last tool_result. */
export function record(n: number, body: any, d: Decision, headers: Record<string, string>): object {
  const sys = typeof body?.system === 'string' ? body.system : text(body?.system)
  const msgs: any[] = body?.messages ?? []
  const last = toolResults(msgs).at(-1)
  const lastBlocks = Array.isArray(last?.content) ? last.content.map((b: any) => b?.type) : last ? ['text'] : []
  return redact({
    n,
    t: Date.now(),
    role: d.role,
    cmd: d.cmd,
    step: d.step,
    nonce: d.nonce,
    model: body?.model,
    stream: body?.stream === true,
    tools: (body?.tools ?? []).map((t: any) => t.name),
    sysLen: sys.length,
    sysSha: createHash('sha256').update(sys).digest('hex').slice(0, 16),
    msgs: msgs.length,
    lastResult: last ? text(last.content).slice(0, 20000) : undefined,
    lastResultBlocks: lastBlocks,
    lastResultIsError: last?.is_error === true,
    lastUser: text(msgs.at(-1)?.content).slice(0, 4000),
    out: d.reply.text ?? d.reply.tools?.map(t => t.name),
    // Secret-named headers are left out, not just blanked, so a scan for their names finds nothing.
    headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !SECRET_KEYS.test(k))),
    secretHeaders: Object.keys(headers).filter(k => SECRET_KEYS.test(k)).length,
  }) as object
}

function serve(): void {
  const scenarioPath = process.env.MOCK_SCENARIO
  if (!scenarioPath) throw new Error('MOCK_SCENARIO=<scenario.json> is required')
  const jsonl = process.env.MOCK_JSONL ?? '/tmp/cmx/conformance/run/mock.jsonl'
  const dump = process.env.MOCK_DUMP
  if (dump) mkdirSync(dump, { recursive: true })
  const work = process.env.WORK ?? '/tmp'
  // Re-read on each request so a driver can switch scenarios without a restart.
  const load = (): Scenario => JSON.parse(readFileSync(process.env.MOCK_SCENARIO_LIVE ?? scenarioPath, 'utf8'))
  let n = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.PORT ?? 18830),
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST') return Response.json({})
      if (url.pathname.endsWith('/v1/messages/count_tokens')) return Response.json({ input_tokens: 10 })
      if (!url.pathname.endsWith('/v1/messages')) return Response.json({})
      const body = await req.json()
      n++
      const d = decide(body, load(), work)
      const headers = Object.fromEntries(req.headers.entries())
      appendFileSync(jsonl, JSON.stringify(record(n, body, d, headers)) + '\n')
      if (dump) writeFileSync(`${dump}/req-${String(n).padStart(4, '0')}.json`, JSON.stringify(redact(body)))
      if (d.reply.delayMs) await Bun.sleep(d.reply.delayMs)
      if (d.reply.status && d.reply.status >= 400)
        return Response.json(
          { type: 'error', error: { type: d.reply.status === 529 ? 'overloaded_error' : 'api_error', message: 'mock' } },
          { status: d.reply.status },
        )
      if (body.stream) return new Response(sse(d.reply, body.model), { headers: { 'content-type': 'text/event-stream' } })
      return Response.json(message(d.reply, body.model))
    },
  })
  console.log(`mock-api up on 127.0.0.1:${server.port}`)
}

if (import.meta.main) serve()
