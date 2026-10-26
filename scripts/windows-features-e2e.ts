// Windows smoke test of features beyond the sandbox, on a built binary.
// Usage: bun scripts/windows-features-e2e.ts <claude.exe>
// Scripted tool calls go through `claude -p` against a fake API; background
// sessions go through the `--bg` / `agents` / `logs` / `stop` commands.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clean, inheritedEnv, printResult, report, runCli, runSteps, startFakeApi, type Step } from './windows-e2e-api.ts'

const bin = path.resolve(process.argv[2] ?? '')
if (!fs.existsSync(bin)) throw new Error(`usage: windows-features-e2e.ts <claude.exe>`)

const api = startFakeApi()
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-features-')))
const config = path.join(root, 'config')
const project = path.join(root, 'project')
fs.mkdirSync(config, { recursive: true })
fs.mkdirSync(project, { recursive: true })
fs.writeFileSync(
  path.join(config, 'settings.json'),
  JSON.stringify({
    memory: { sqlite: { enabled: true } },
    skipDangerousModePermissionPrompt: true,
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "$CLAUDE_PROJECT_DIR" >> hook.log' }] },
      ],
    },
  }),
)
fs.writeFileSync(
  path.join(config, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    // Background sessions are interactive and would ask about the key.
    customApiKeyResponses: { approved: ['sk-fake'], rejected: [] },
    // Config keys use forward slashes (normalizePathForConfigKey).
    projects: { [project.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } },
  }),
)

// A stdio MCP server with one tool, speaking newline-delimited JSON-RPC.
const mcpServer = path.join(root, 'mcp-server.mjs')
fs.writeFileSync(
  mcpServer,
  `import readline from 'node:readline'
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  if (method === 'initialize') send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'smoke', version: '1' } } })
  else if (method === 'tools/list') send({ id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } }] } })
  else if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: 'pong from ' + process.platform }] } })
  else send({ id, error: { code: -32601, message: 'unknown method' } })
})
`,
)
const mcpConfig = path.join(root, 'mcp.json')
fs.writeFileSync(
  mcpConfig,
  JSON.stringify({ mcpServers: { smoke: { command: process.execPath, args: [mcpServer] } } }),
)

const env = {
  ...inheritedEnv(),
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-fake',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
}

const file = path.join(project, 'notes.txt')
const noError = (out: string) => !/tool_use_error|^Error|"error":\{/m.test(out)
// The script targets Windows; the other platforms can dry-run it.
const terminalShell = process.platform === 'win32' ? 'cmd.exe' : 'bash'
const checks: { step: Step; expect: (out: string) => boolean }[] = [
  { step: { name: 'Bash', input: { command: 'mkdir -p sub && cd sub && pwd', description: 'e2e' } }, expect: out => clean(out) && /\/sub$/.test(out.trim()) },
  { step: { name: 'Bash', input: { command: 'pwd', description: 'e2e' } }, expect: out => clean(out) && /\/sub$/.test(out.trim()) },
  { step: { name: 'PowerShell', input: { command: '(Get-Location).Path', description: 'e2e' } }, expect: out => clean(out) && /\\sub$/.test(out.trim()) },
  { step: { name: 'Write', input: { file_path: file, content: 'alpha\r\nbeta\r\n' } }, expect: noError },
  { step: { name: 'Read', input: { file_path: file } }, expect: out => out.includes('beta') },
  { step: { name: 'Edit', input: { file_path: file, old_string: 'beta', new_string: 'gamma' } }, expect: noError },
  { step: { name: 'Grep', input: { pattern: 'gamma', path: project, output_mode: 'content' } }, expect: out => out.includes('notes.txt') },
  { step: { name: 'Glob', input: { pattern: '**/*.txt', path: project } }, expect: out => out.includes('notes.txt') },
  { step: { name: 'mcp__smoke__ping', input: {} }, expect: out => out.includes(`pong from ${process.platform}`) },
  { step: { name: 'SearchMemory', input: { query: 'windows smoke' } }, expect: noError },
  { step: { name: 'Terminal', input: { action: 'new-session', command: terminalShell } }, expect: out => out.includes('"isRunning":true') },
  { step: { name: 'Terminal', input: { action: 'send-keys', target: '$SESSION', text: 'echo smoke-pty', enter: true } }, expect: noError },
  { step: { name: 'Bash', input: { command: `bun -e 'await Bun.sleep(1500)'; echo waited`, description: 'e2e' } }, expect: out => out.includes('waited') },
  { step: { name: 'Terminal', input: { action: 'capture-pane', target: '$SESSION' } }, expect: out => /smoke-pty[\s\S]*smoke-pty/.test(out) },
  { step: { name: 'Terminal', input: { action: 'resize-pane', target: '$SESSION', cols: 100, rows: 30 } }, expect: noError },
  { step: { name: 'Terminal', input: { action: 'kill-pane', target: '$SESSION' } }, expect: noError },
]

const results = await runSteps(bin, checks.map(c => c.step), {
  cwd: project,
  env,
  args: ['--mcp-config', mcpConfig],
})
let failed = report(checks, results)

const hookLog = path.join(project, 'hook.log')
const hooked = fs.existsSync(hookLog) && fs.readFileSync(hookLog, 'utf8').trim()
console.log(`${hooked ? 'PASS' : 'FAIL'} PreToolUse command hook\n  ${hooked || '<no hook.log>'}`)
if (!hooked) failed++

// Background session through the daemon (Windows named pipes).
const run = (...args: string[]) => runCli(bin, args, { cwd: project, env })
const bg = await run('--bg', '-n', 'smoke', '--dangerously-skip-permissions', `STEPS:${JSON.stringify([{ name: 'Bash', input: { command: 'echo bg-ok', description: 'e2e' } }])}`)
console.log(`--bg: ${bg}`)
let logs = ''
for (let i = 0; i < 45 && !logs.includes('bg-ok'); i++) {
  await Bun.sleep(1000)
  logs = await run('logs', 'smoke')
}
let listed: { name?: string; status?: string; state?: string }[] = []
try {
  listed = JSON.parse(await run('agents', '--json', '--all'))
} catch {}
const session = listed.find(s => s.name === 'smoke')
const bgChecks: [string, boolean, string][] = [
  ['background session starts', /backgrounded/.test(bg), bg],
  ['logs shows its output', logs.includes('bg-ok'), logs],
  // Official reports a busy session as "working".
  ['agents --json lists it running', /^(running|working)$/.test(session?.state ?? ''), JSON.stringify(session ?? listed)],
]
// Official `stop` takes the id, not the name.
const stop = await run('stop', bg.match(/backgrounded · (\w+)/)?.[1] ?? 'smoke')
bgChecks.push(['stop', /stopped/.test(stop), stop])
for (const [name, ok, out] of bgChecks) {
  if (!ok) failed++
  printResult(ok, name, out)
}

api.stop()
// The daemon keeps the folder open until it idles out.
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 1000 })
} catch (error) {
  console.log(`cleanup: ${error}`)
}
if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
