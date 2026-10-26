// Cross-session features on a built binary: peer messaging between two local
// sessions, and Direct Connect (`claude server` + `cc://`) where the binary
// has it. Usage: bun scripts/windows-sessions-e2e.ts <claude.exe>
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clean, inheritedEnv, report, runCli, runSteps, startFakeApi, type Step } from './windows-e2e-api.ts'

const bin = path.resolve(process.argv[2] ?? '')
if (!fs.existsSync(bin)) throw new Error(`usage: windows-sessions-e2e.ts <claude.exe>`)

const api = startFakeApi()
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-sessions-')))
const config = path.join(root, 'config')
const project = path.join(root, 'project')
fs.mkdirSync(config, { recursive: true })
fs.mkdirSync(project, { recursive: true })
fs.writeFileSync(
  path.join(config, 'settings.json'),
  JSON.stringify({ crossSessionInbound: 'accept', skipDangerousModePermissionPrompt: true }),
)
fs.writeFileSync(
  path.join(config, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: ['sk-fake'], rejected: [] },
    projects: { [project.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } },
  }),
)
const env = {
  ...inheritedEnv(),
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-fake',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  // ListAgents and SendMessage are deferred behind ToolSearch otherwise.
  ENABLE_TOOL_SEARCH: 'false',
}
const run = (...args: string[]) => runCli(bin, args, { cwd: project, env })
let failed = 0
const check = (name: string, ok: boolean, out: string) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}\n  ${out.trim().replace(/\n/g, '\n  ')}`)
}

// Peer messaging: a background session receives from a `-p` session.
const bg = await run('--bg', '-n', 'peer-b', '--dangerously-skip-permissions', 'wait for messages')
check('receiver starts in the background', /backgrounded/.test(bg), bg)
let logs = ''
for (let i = 0; i < 30 && !/done/.test(logs); i++) {
  await Bun.sleep(1000)
  logs = await run('logs', 'peer-b')
}
const sendSteps: { step: Step; expect: (out: string) => boolean }[] = [
  { step: { name: 'ListAgents', input: {} }, expect: out => out.includes('peer-b') },
  {
    step: { name: 'SendMessage', input: { to: 'peer-b', message: 'hello-from-peer-a', summary: 'e2e' } },
    expect: out => !/error|not found|No session/i.test(out),
  },
]
failed += report(
  sendSteps,
  await runSteps(bin, sendSteps.map(c => c.step), {
    cwd: project,
    env,
    args: ['--name', 'peer-a'],
  }),
)
for (let i = 0; i < 30 && !logs.includes('hello-from-peer-a'); i++) {
  await Bun.sleep(1000)
  logs = await run('logs', 'peer-b')
}
check('receiver shows the message', logs.includes('hello-from-peer-a'), logs)
// Official `stop` takes the id, not the name.
const bgId = bg.match(/backgrounded · (\w+)/)?.[1] ?? 'peer-b'
const stopped = await run('stop', bgId)
check('receiver stops', /stopped/.test(stopped), stopped)

// Direct Connect, fork only.
if (!/Start a Claude Code session server/.test(await run('server', '--help'))) {
  console.log('SKIP Direct Connect: this binary has no `claude server`')
} else {
  const token = 'e2e-token-1234567890'
  const server = Bun.spawn([bin, 'server', '--port', '0', '--auth-token', token, '--workspace', project], {
    cwd: project,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let banner = ''
  const reader = server.stdout.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 30_000
  while (!/cc:\/\/[^\s]+/.test(banner) && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    banner += decoder.decode(value)
  }
  const url = banner.match(/cc:\/\/[^\s]+/)?.[0]
  check('server prints a cc:// URL', !!url, banner)
  if (url) {
    const dcSteps: { step: Step; expect: (out: string) => boolean }[] = [
      { step: { name: 'Bash', input: { command: 'echo dc-ok > dc.txt && cat dc.txt && pwd', description: 'e2e' } }, expect: out => clean(out) && out.includes('dc-ok') },
    ]
    failed += report(
      dcSteps,
      await runSteps(bin, dcSteps.map(c => c.step), { cwd: project, env, prefixArgs: [url], verbose: false }),
    )
    check('the session ran on the server side', fs.existsSync(path.join(project, 'dc.txt')), '')
  }
  server.kill()
  await server.exited
}

api.stop()
try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 1000 })
} catch (error) {
  console.log(`cleanup: ${error}`)
}
if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
