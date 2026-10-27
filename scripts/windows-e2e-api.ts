// Fake Anthropic API and a `claude -p` runner for the Windows e2e scripts.
// The prompt carries `STEPS:<json>`; step i is sent as a tool call after i
// tool results. `$SESSION` in a step is replaced with the last Terminal
// `target` a tool result reported.
import { spawn } from 'node:child_process'

export type Step = { name: string; input: Record<string, unknown> }

export const text = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map(b => b.text ?? (b.content ? text(b.content) : '')).join('\n')
      : ''

function sse(step: Step | undefined, model: string): string {
  const ev = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const block = step
    ? { type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2)}`, name: step.name, input: {} }
    : { type: 'text', text: '' }
  const delta = step
    ? { type: 'input_json_delta', partial_json: JSON.stringify(step.input) }
    : { type: 'text_delta', text: 'done' }
  return [
    ev('message_start', {
      message: { id: 'msg_e2e', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
    }),
    ev('content_block_start', { index: 0, content_block: block }),
    ev('content_block_delta', { index: 0, delta }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', {
      delta: { stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
    ev('message_stop', {}),
  ].join('')
}

export function startFakeApi(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.endsWith('/v1/messages/count_tokens')) {
        return Response.json({ input_tokens: 10 })
      }
      if (req.method !== 'POST' || !url.pathname.endsWith('/v1/messages')) {
        return Response.json({})
      }
      const body = await req.json()
      const messages: { role: string; content: unknown }[] = body.messages ?? []
      const prompt = messages.filter(m => m.role === 'user').map(m => text(m.content)).join('\n')
      const match = prompt.match(/STEPS:(\[.*\])\s*$/m)
      const steps: Step[] = match ? JSON.parse(match[1]!) : []
      const results = messages.flatMap(m =>
        Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : [],
      )
      if (!body.stream) {
        return Response.json({
          id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model,
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }
      let step = steps[results.length]
      const session = [...results.map(r => text(r.content)).join('\n').matchAll(/"target":\s*"([^"]+)"/g)].at(-1)?.[1]
      if (step && session) {
        step = JSON.parse(JSON.stringify(step).replaceAll('$SESSION', session))
      }
      return new Response(sse(step, body.model), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/** Runs `claude -p` over the steps and returns each tool result's text. */
export async function runSteps(
  bin: string,
  steps: Step[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; args?: string[]; prefixArgs?: string[]; verbose?: boolean },
): Promise<string[]> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      bin,
      [
        ...(opts.prefixArgs ?? []),
        '-p',
        `STEPS:${JSON.stringify(steps)}`,
        '--output-format',
        'stream-json',
        ...(opts.verbose === false ? [] : ['--verbose']),
        '--dangerously-skip-permissions',
        ...(opts.args ?? []),
      ],
      { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => process.stderr.write(d))
    const timer = setTimeout(() => child.kill(), 300_000)
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
  const results: string[] = []
  for (const line of output.split('\n')) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.type !== 'user') continue
    for (const block of message.message?.content ?? []) {
      if (block.type === 'tool_result') results.push(text(block.content))
    }
  }
  return results
}

/**
 * One PASS/FAIL line. A pass shows the first line of its output, a failure
 * the output without ANSI codes (a background session's screen is long).
 */
export function printResult(ok: boolean, name: string, out: string): void {
  const plain = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
  const shown = ok ? (plain.split('\n')[0] ?? '').slice(0, 200) : plain.slice(-4000)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${shown ? `\n  ${shown.replace(/\n/g, '\n  ')}` : ''}`)
}

/** Prints PASS/FAIL per check; a missing result is a failure. */
export function report(
  checks: { step: Step; expect: (out: string) => boolean }[],
  results: string[],
): number {
  let failed = 0
  checks.forEach((check, i) => {
    const out = results[i]
    const ok = out !== undefined && check.expect(out)
    if (!ok) failed++
    printResult(ok, `${check.step.name} ${JSON.stringify(check.step.input)}`, out ?? '<no result>')
  })
  return failed
}

/**
 * The runner's env without inherited Claude/Anthropic variables (a remote
 * session's, a CI token, CCR auth), which would change what the binary under test does.
 */
export function inheritedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|CCR)_/.test(k)),
  )
}

/**
 * Runs one CLI command and returns stdout+stderr. Async on purpose: the fake
 * API runs in this process and must keep answering meanwhile.
 */
export async function runCli(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const child = Bun.spawn([bin, ...args], { cwd: opts.cwd, env: opts.env, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 60_000)
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  clearTimeout(timer)
  return `${out}${err}`.trim()
}

/** A command that should succeed must not report a non-zero exit. */
export const clean = (out: string) => !/^Exit code/m.test(out)
