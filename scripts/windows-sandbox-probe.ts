// Probes what the Windows sandbox runtime can do on this machine.
// Run with: bun scripts/windows-sandbox-probe.ts
import { spawn } from 'node:child_process'
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
// The proxy runs in this process, so the child must be spawned
// asynchronously or network requests hang.
function run(argv: string[], env: NodeJS.ProcessEnv) {
  return new Promise<Record<string, unknown>>(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: work, env, shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    const timer = setTimeout(() => child.kill(), 60_000)
    child.on('error', e => resolve({ error: e.message }))
    child.on('close', status => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

// srt-win copied under the host profile, where an extracted binary would live.
const profileSrtWin = path.join(
  process.env.LOCALAPPDATA ?? os.homedir(),
  'srt-probe',
  'srt-win.exe',
)
fs.mkdirSync(path.dirname(profileSrtWin), { recursive: true })
fs.copyFileSync(VENDORED_SRT_WIN_EXE, profileSrtWin)

for (const [name, command] of Object.entries(cases)) {
  try {
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
      command,
      gitBash,
      undefined,
      undefined,
      work,
    )
    log(`case ${name}`, await run(argv, env))
  } catch (e) {
    log(`case ${name} threw`, String(e))
  }
}

try {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    'whoami',
    gitBash,
    { windows: { srtWin: { path: profileSrtWin } } },
    undefined,
    work,
  )
  log('srt-win under profile', await run(argv, env))
} catch (e) {
  log('srt-win under profile threw', String(e))
}

// Terminal tool: a PTY around the sandboxed shell.
try {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    'echo in-pty; whoami; tty; [ -t 0 ] && echo stdin-is-tty; read x; echo got=$x',
    gitBash,
    undefined,
    undefined,
    work,
  )
  let out = ''
  const proc = Bun.spawn(argv, {
    cwd: work,
    env,
    terminal: {
      cols: 100,
      rows: 30,
      data(_t, d) {
        out += new TextDecoder().decode(d)
      },
    },
  })
  const typing = setTimeout(() => proc.terminal?.write('typed-input\r'), 5_000)
  const timer = setTimeout(() => proc.kill(), 60_000)
  await proc.exited
  clearTimeout(typing)
  clearTimeout(timer)
  log('sandboxed pty', { exitCode: proc.exitCode, out })
} catch (e) {
  log('sandboxed pty threw', String(e))
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
