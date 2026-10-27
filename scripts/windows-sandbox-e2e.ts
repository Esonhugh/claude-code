// End-to-end check of the native Windows sandbox on a built binary.
// Usage: bun scripts/windows-sandbox-e2e.ts <claude.exe>
// Installs the sandbox first (one UAC prompt; none on a CI runner), then runs
// scripted Bash and Terminal calls through `claude -p` against a fake API.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clean, inheritedEnv, report, runSteps, startFakeApi, type Step } from './windows-e2e-api.js'

const bin = path.resolve(process.argv[2] ?? '')
if (!fs.existsSync(bin)) throw new Error(`usage: windows-sandbox-e2e.ts <claude.exe>`)

const api = startFakeApi()

// Long names: the runner's TEMP is 8.3 (RUNNER~1), `pwd -P` is not.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-win-sandbox-')))
// The real profile stays HOME: the sandbox user is granted its way from the
// profile down to a project inside it, as on a user's machine.
const config = path.join(root, 'config')
const project = path.join(root, 'project')
fs.mkdirSync(config, { recursive: true })
fs.mkdirSync(path.join(project, 'sub'), { recursive: true })
fs.writeFileSync(
  path.join(config, 'settings.json'),
  JSON.stringify({
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      // Strict: a host outside the allowlist is refused without a network
      // ask, which --dangerously-skip-permissions would allow.
      network: { allowedDomains: ['example.com'], strictAllowlist: true },
    },
  }),
)
fs.writeFileSync(
  path.join(config, '.claude.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    // Config keys use forward slashes (normalizePathForConfigKey).
    projects: { [project.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } },
  }),
)
const secret = path.join(root, 'secret.txt')
fs.writeFileSync(secret, 'host-secret')

const env = {
  ...inheritedEnv(),
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'sk-fake',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_USE_POWERSHELL_TOOL: '1',
  // Official 2.1.303 gates its Windows sandbox behind this; the fork ignores it.
  CLAUDE_CODE_NANKEEN_KESTREL: '1',
}

const install = spawnSync(bin, ['sandbox', 'install'], { env, encoding: 'utf8' })
console.log(`sandbox install: exit=${install.status} ${install.stdout}${install.stderr}`)
const status = spawnSync(bin, ['sandbox', 'status'], { cwd: project, env, encoding: 'utf8' })
console.log(`sandbox status: ${status.stdout}${status.stderr}`)

const posix = (p: string) => p.replace(/\\/g, '/')
const bash = (command: string) => ({ name: 'Bash', input: { command, description: 'e2e' } })
const pwsh = (command: string) => ({ name: 'PowerShell', input: { command, description: 'e2e' } })
const checks: { step: Step; expect: (out: string) => boolean }[] = [
  { step: bash('whoami'), expect: out => clean(out) && out.includes('ClaudeCodeSandbox') },
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
  { step: pwsh('whoami'), expect: out => clean(out) && out.includes('ClaudeCodeSandbox') },
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
const results = await runSteps(bin, checks.map(c => c.step), {
  cwd: project,
  env,
  args: ['--debug-file', debugLog],
})
api.stop()

const failed = report(checks, results)
if (failed && fs.existsSync(debugLog)) {
  console.log('--- sandbox lines from the debug log')
  const lines = fs.readFileSync(debugLog, 'utf8').split('\n').filter(line => /sandbox|srt-win/i.test(line))
  for (const line of lines.slice(-80)) console.log(line.slice(0, 1000))
}
fs.rmSync(root, { recursive: true, force: true })
if (failed) {
  console.log(`${failed} check(s) failed`)
  process.exit(1)
}
