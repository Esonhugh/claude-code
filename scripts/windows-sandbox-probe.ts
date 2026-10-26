// Probes what the Windows sandbox runtime can do on this machine.
// Run with: bun scripts/windows-sandbox-probe.ts
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
  checkWindowsDependenciesAsync,
  checkWindowsSandboxStatusAsync,
  installWindowsSandboxAsync,
  resolveSrtWin,
} from '@anthropic-ai/sandbox-runtime'

function log(title: string, value: unknown) {
  console.log(`\n=== ${title}`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const srtWin = resolveSrtWin({ path: VENDORED_SRT_WIN_EXE })
log('srt-win', srtWin)
log('status before install', await checkWindowsSandboxStatusAsync({ srtWin }))
try {
  log('install', await installWindowsSandboxAsync({ srtWin }))
} catch (e) {
  log('install failed', String(e))
}
log('deps', await checkWindowsDependenciesAsync({ srtWin }))

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-probe-'))
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
log('workdir', work)

await SandboxManager.initialize({
  network: { allowedDomains: ['example.com'], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [work], denyWrite: [] },
  windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } },
})

const profileFile = path.join(os.homedir(), 'srt-probe-home.txt')
fs.writeFileSync(profileFile, 'host-secret')
const cases: Record<string, string> = {
  whoami: 'whoami',
  writeWorkdir: 'echo ok > inside.txt && cat inside.txt',
  writeWindows: 'echo x > /c/Windows/srt-probe.txt; echo exit=$?',
  readHome: `cat '${profileFile.replace(/\\/g, '/')}'; echo exit=$?`,
  writeHostTemp: `echo x > '${path.join(os.tmpdir(), 'srt-probe-outside.txt').replace(/\\/g, '/')}'; echo exit=$?`,
  curlAllowed:
    'curl -sS -o /dev/null -w "%{http_code}" https://example.com; echo " exit=$?"',
  curlDenied:
    'curl -sS -o /dev/null -w "%{http_code}" https://github.com; echo " exit=$?"',
  env: 'echo HOME=$HOME TEMP=$TEMP USERPROFILE=$USERPROFILE; pwd',
}
for (const [name, command] of Object.entries(cases)) {
  try {
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
      command,
      gitBash,
      undefined,
      undefined,
      work,
    )
    const r = spawnSync(argv[0]!, argv.slice(1), {
      cwd: work,
      env,
      shell: false,
      encoding: 'utf8',
      timeout: 60_000,
    })
    log(`case ${name}`, {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.error?.message,
    })
  } catch (e) {
    log(`case ${name} threw`, String(e))
  }
}
await SandboxManager.reset()

// Bun terminal (PTY) support, which the Terminal tool needs.
try {
  let out = ''
  const proc = Bun.spawn(['cmd.exe', '/d', '/c', 'echo pty-ok'], {
    terminal: {
      cols: 80,
      rows: 24,
      data(_t, d) {
        out += new TextDecoder().decode(d)
      },
    },
  })
  await proc.exited
  log('bun pty', { terminal: !!proc.terminal, out })
} catch (e) {
  log('bun pty threw', String(e))
}
