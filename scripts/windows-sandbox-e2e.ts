// End-to-end check of the native Windows sandbox on a built binary.
// Usage: bun scripts/windows-sandbox-e2e.ts <claude.exe>
// Installs the sandbox first (one UAC prompt; none on a CI runner), then runs
// scripted Bash and Terminal calls through `claude -p` against a fake API.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bin = path.resolve(process.argv[2] ?? '')
if (!fs.existsSync(bin)) throw new Error(`usage: windows-sandbox-e2e.ts <claude.exe>`)

type Step = { name: string; input: Record<string, unknown> }
const text = (c: unknown): string =>
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

// The first user message carries `STEPS:<json>`; step i is sent after i results.
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
    return new Response(sse(steps[results.length], body.model), {
      headers: { 'content-type': 'text/event-stream' },
    })
  },
})

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-sandbox-'))
const home = path.join(root, 'home')
const project = path.join(root, 'project')
fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
fs.mkdirSync(path.join(project, 'sub'), { recursive: true })
fs.writeFileSync(
  path.join(home, '.claude', 'settings.json'),
  JSON.stringify({
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ['example.com'] },
    },
  }),
)
fs.writeFileSync(
  path.join(home, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [project]: { hasTrustDialogAccepted: true } },
  }),
)
const secret = path.join(home, 'secret.txt')
fs.writeFileSync(secret, 'host-secret')

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
  ANTHROPIC_API_KEY: 'sk-fake',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
}

const install = spawnSync(bin, ['sandbox', 'install'], { env, encoding: 'utf8' })
console.log(`sandbox install: exit=${install.status} ${install.stdout}${install.stderr}`)
const status = spawnSync(bin, ['sandbox', 'status'], { cwd: project, env, encoding: 'utf8' })
console.log(`sandbox status: ${status.stdout}${status.stderr}`)

const posix = (p: string) => p.replace(/\\/g, '/')
const bash = (command: string) => ({ name: 'Bash', input: { command, description: 'e2e' } })
const pwsh = (command: string) => ({ name: 'PowerShell', input: { command, description: 'e2e' } })
// A command that should succeed must not report a non-zero exit.
const clean = (out: string) => !/^Exit code/m.test(out)
const checks: { step: Step; expect: (out: string) => boolean }[] = [
  { step: bash('whoami'), expect: out => clean(out) && out.includes('srt-sandbox') },
  { step: bash('echo ok > inside.txt && cat inside.txt'), expect: out => clean(out) && out.includes('ok') },
  { step: bash('echo x > /c/Windows/cc-e2e.txt'), expect: out => /Permission denied/.test(out) },
  { step: bash(`cat '${posix(secret)}'`), expect: out => /Permission denied/.test(out) },
  {
    step: bash('curl -sS -o /dev/null -w "%{http_code}" https://example.com'),
    expect: out => clean(out) && out.includes('200'),
  },
  {
    step: bash('curl -sS -o /dev/null -w "%{http_code}" https://github.com'),
    expect: out => out.includes('403'),
  },
  { step: bash('echo "$GIT_EDITOR $CLAUDECODE"'), expect: out => clean(out) && out.includes('true 1') },
  { step: bash('cd sub'), expect: out => clean(out) && !/Sandbox|error/i.test(out) },
  { step: bash('pwd'), expect: out => clean(out) && /\/sub\s*$/.test(out.trim()) },
  { step: pwsh('whoami'), expect: out => clean(out) && out.includes('srt-sandbox') },
  {
    step: pwsh('Set-Content -Path ps.txt -Value ok; Get-Content ps.txt'),
    expect: out => clean(out) && out.includes('ok'),
  },
  {
    step: pwsh('Set-Content -Path C:\\Windows\\cc-e2e-ps.txt -Value x'),
    expect: out => /Access to the path .* is denied/i.test(out),
  },
  {
    step: { name: 'Terminal', input: { action: 'new-session', command: 'cmd.exe' } },
    expect: out => out.includes('cannot run inside the Windows sandbox'),
  },
]

const debugLog = path.join(root, 'debug.log')
const output = await new Promise<string>((resolve, reject) => {
  const child = spawn(
    bin,
    [
      '-p',
      `STEPS:${JSON.stringify(checks.map(c => c.step))}`,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--debug-file',
      debugLog,
    ],
    { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] },
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
server.stop(true)

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

let failed = 0
checks.forEach((check, i) => {
  const out = results[i]
  const ok = out !== undefined && check.expect(out)
  if (!ok) failed++
  const shown = (out ?? '<no result>').trim().replace(/\n/g, '\n  ')
  console.log(`${ok ? 'PASS' : 'FAIL'} ${JSON.stringify(check.step.input)}\n  ${shown}`)
})
if (failed && fs.existsSync(debugLog)) {
  console.log('--- sandbox lines from the debug log')
  for (const line of fs.readFileSync(debugLog, 'utf8').split('\n')) {
    if (/sandbox|srt-win/i.test(line)) console.log(line.slice(0, 2000))
  }
}
fs.rmSync(root, { recursive: true, force: true })
if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
