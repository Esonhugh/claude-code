// End-to-end check of the macOS (Seatbelt) Bash sandbox on a built binary.
// Usage: bun scripts/macos-sandbox-e2e.ts <claude> [--official]
// Runs scripted Bash and Terminal calls through `claude -p` against a fake API.
// --official skips the fork-only Terminal checks.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clean, inheritedEnv, report, runSteps, startFakeApi, type Step } from './windows-e2e-api.js'

const bin = path.resolve(process.argv[2] ?? '')
if (!fs.existsSync(bin)) throw new Error(`usage: macos-sandbox-e2e.ts <claude> [--official]`)
const official = process.argv.includes('--official')

const api = startFakeApi()

// /var/folders is a symlink to /private/var/folders; Seatbelt matches real paths.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mac-sandbox-')))
const config = path.join(root, 'config')
const project = path.join(root, 'project')
fs.mkdirSync(config, { recursive: true })
fs.mkdirSync(path.join(project, 'sub'), { recursive: true })
fs.mkdirSync(path.join(project, '.claude'), { recursive: true })
spawnSync('git', ['init', '-q'], { cwd: project })
const secret = path.join(root, 'secret.txt')
fs.writeFileSync(secret, 'host-secret')
// Outside the project and the temp dirs the sandbox allows writing.
const outside = path.join(os.homedir(), `cc-mac-e2e-${process.pid}`)
fs.mkdirSync(outside, { recursive: true })

fs.writeFileSync(
  path.join(config, 'settings.json'),
  JSON.stringify({
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { denyRead: [secret] },
      // Strict: a host outside the allowlist is refused without a network
      // ask, which --dangerously-skip-permissions would allow.
      network: { allowedDomains: ['example.com'], strictAllowlist: true },
    },
  }),
)
fs.writeFileSync(
  path.join(config, '.claude.json'),
  JSON.stringify({ hasCompletedOnboarding: true, projects: { [project]: { hasTrustDialogAccepted: true } } }),
)

const env = {
  ...inheritedEnv(),
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-fake',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}

const denied = (out: string) => /Operation not permitted/.test(out)
const bash = (command: string, extra: Record<string, unknown> = {}) => ({
  name: 'Bash',
  input: { command, description: 'e2e', ...extra },
})
const wait = bash(`python3 -c 'import time; time.sleep(1.5)'; echo waited`)
const checks: { step: Step; expect: (out: string) => boolean }[] = [
  { step: bash('echo ok > inside.txt && cat inside.txt'), expect: out => clean(out) && out.includes('ok') },
  { step: bash(`echo x > '${outside}/bash.txt'`), expect: denied },
  { step: bash('echo x > /usr/local/cc-e2e.txt'), expect: denied },
  { step: bash(`cat '${secret}'`), expect: out => denied(out) && !out.includes('host-secret') },
  { step: bash('echo x > .claude/settings.json'), expect: denied },
  { step: bash('echo x > .git/hooks/pre-commit'), expect: denied },
  { step: bash('echo x >> .git/config'), expect: denied },
  {
    step: bash('echo t > "$TMPDIR/cc-e2e.txt" && cat "$TMPDIR/cc-e2e.txt"'),
    expect: out => clean(out) && out.includes('t'),
  },
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
  {
    step: bash(`echo x > '${outside}/unsandboxed.txt' && echo wrote`, { dangerouslyDisableSandbox: true }),
    expect: out => clean(out) && out.includes('wrote'),
  },
]
if (!official) {
  checks.push(
    { step: { name: 'Terminal', input: { action: 'new-session', command: 'bash' } }, expect: out => out.includes('"isRunning":true') },
    {
      step: {
        name: 'Terminal',
        input: { action: 'send-keys', target: '$SESSION', text: `echo x > '${outside}/term.txt'; echo term-exit-$?`, enter: true },
      },
      expect: out => !/error/i.test(out),
    },
    { step: wait, expect: out => out.includes('waited') },
    {
      step: { name: 'Terminal', input: { action: 'capture-pane', target: '$SESSION' } },
      expect: out => denied(out) && out.includes('term-exit-1'),
    },
    { step: { name: 'Terminal', input: { action: 'kill-pane', target: '$SESSION' } }, expect: out => !/error/i.test(out) },
  )
}

const debugLog = path.join(root, 'debug.log')
const results = await runSteps(bin, checks.map(c => c.step), {
  cwd: project,
  env,
  args: ['--debug-file', debugLog],
})
api.stop()

let failed = report(checks, results)
// The denied writes must not have happened.
for (const name of ['bash.txt', 'term.txt']) {
  if (fs.existsSync(path.join(outside, name))) {
    console.log(`FAIL ${name} was written outside the sandbox`)
    failed++
  }
}
if (failed && fs.existsSync(debugLog)) {
  console.log('--- sandbox lines from the debug log')
  const lines = fs.readFileSync(debugLog, 'utf8').split('\n').filter(line => /sandbox|seatbelt/i.test(line))
  for (const line of lines.slice(-80)) console.log(line.slice(0, 1000))
}
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(outside, { recursive: true, force: true })
if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
