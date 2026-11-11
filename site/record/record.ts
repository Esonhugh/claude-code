// Records the real CLI in tmux for the site's tour and writes src/demos/recordings/<scene>.<lang>.json.
// Usage (from site/, after `make build`): bun record/record.ts [--scene goal] [--lang en] [--binary ../built-claude]
// The model side is scripted per scene (scenes.ts); everything on screen is drawn by the real binary.
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Lang } from '../src/demos/i18n'
import { serveScript } from './api'
import { convert } from './convert'
import { type SceneDef, SCENES } from './scenes'

const { values } = parseArgs({ options: { binary: { type: 'string', default: '../built-claude' }, lang: { type: 'string' }, scene: { type: 'string' } } })
const BINARY = resolve(values.binary!)
// Marking this version's release notes as seen keeps the startup banner compact.
const VERSION = Bun.spawnSync([BINARY, '--version']).stdout.toString().split(' ')[0]
const PORT = 18801
const SESSION = 'site-record'
const INNER = 'site-record-inner'
// The fake API key must be pre-approved by its last 20 characters, so it is exactly 20 long.
const API_KEY = 'demo0000000000000000'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const tmux = (...args: string[]) => Bun.spawnSync(['tmux', ...args]).stdout.toString()
const screen = () => tmux('capture-pane', '-t', SESSION, '-p')

// Waits until `until` shows up, or by default until the CLI is idle and the screen has stopped changing.
async function settle(until?: RegExp) {
  let last = ''
  let stableSince = performance.now()
  for (const end = performance.now() + 120_000; performance.now() < end; await sleep(150)) {
    const now = screen()
    if (until) {
      if (until.test(now)) return
      continue
    }
    if (now !== last) {
      last = now
      stableSince = performance.now()
    } else if (!now.includes('esc to interrupt') && performance.now() - stableSince > 1200) return
  }
}

// Keys go to the recorded session, or to one pane of the inner tmux in a split scene.
const keys = (pane: number | undefined, ...args: string[]) => (pane === undefined ? tmux('send-keys', '-t', SESSION, ...args) : tmux('-L', INNER, 'send-keys', '-t', `in:0.${pane}`, ...args))

async function type(text: string, pane?: number) {
  for (const ch of text) {
    keys(pane, '-l', ch)
    await sleep(30 + Math.random() * 40)
  }
  await sleep(400)
  keys(pane, 'Enter')
}

async function record(name: string, scene: SceneDef, lang: Lang) {
  // A fixed home keeps absolute paths on screen (e.g. in /peers) short and the same in every take.
  const home = join(tmpdir(), 'demo')
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home)
  const project = join(home, 'projects/search-demo')
  const [cols, rows] = scene.size ?? [80, 22]
  // Each pane may work in its own copy of the fixture, so two CLIs doing the same task don't see each other's edits.
  const projects = [project, ...(scene.panes ?? []).flatMap(p => (p.project ? [join(home, 'projects', p.project)] : []))]
  for (const dir of projects)
    for (const [path, body] of Object.entries(scene.fixture)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), body)
    }
  for (const [to, from] of Object.entries(scene.copy ?? {})) cpSync(join(import.meta.dir, '..', from), join(project, to), { recursive: true })
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(home, 'bin'))
  symlinkSync(BINARY, join(home, 'bin/claude'))
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      lastReleaseNotesSeen: VERSION,
      opus1mMergeNoticeSeenCount: 99,
      esonhughMarketplaceAutoInstallAttempted: true,
      esonhughMarketplaceAutoInstalled: true,
      customApiKeyResponses: { approved: [API_KEY], rejected: [] },
      projects: Object.fromEntries(projects.map(dir => [dir, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])),
      ...scene.config,
    }),
  )
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ ...(scene.chatgpt ? {} : { model: 'claude-sonnet-5-5' }), permissions: { allow: scene.allow } }))

  const auth = process.env.CODEX_AUTH_FILE
  if (scene.chatgpt) {
    if (!auth || !existsSync(auth)) throw new Error(`scene ${name} needs CODEX_AUTH_FILE pointing at a ChatGPT sign-in (~/.codex/auth.json)`)
    mkdirSync(join(home, '.codex'))
    cpSync(auth, join(home, '.codex/auth.json'))
  }
  const server = serveScript(PORT, scene.script(lang, project))
  const env = [
    `PATH=${home}/bin:${process.env.PATH}`,
    `HOME=${home}`,
    'TERM=xterm-256color',
    'COLORTERM=truecolor',
    'LANG=C.UTF-8',
    "PS1='$ '",
    'IS_SANDBOX=1',
    'ENABLE_TOOL_SEARCH=false',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    `ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}`,
    `ANTHROPIC_API_KEY=${API_KEY}`,
    ...(scene.env ?? []),
    // The real ChatGPT side reaches OpenAI through this container's proxy.
    ...(scene.chatgpt ? [...['HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'].filter(k => process.env[k]).map(k => `${k}=${process.env[k]}`), 'NO_PROXY=127.0.0.1,localhost'] : []),
  ]
  let program = scene.shell ? 'bash --norc --noprofile' : 'claude'
  // A split scene runs its CLIs as panes of an inner tmux, so both show up in one recording.
  if (scene.panes) {
    writeFileSync(
      join(home, 'tmux.conf'),
      ['set -g status off', 'set -g default-terminal xterm-256color', "set -as terminal-features ',xterm-256color:RGB'", 'set -g pane-border-status top', "set -g pane-border-format ' #{@label} '"].join('\n'),
    )
    const [first, ...rest] = scene.panes
    const cwd = (p: { project?: string }) => (p.project ? ` -c ${join(home, 'projects', p.project)}` : '')
    const split = rest.map(p => ` \\; split-window -v${cwd(p)} '${p.command}'`).join('')
    const labels = scene.panes.map((p, i) => ` \\; set -p -t in:0.${i} @label ${p.label}`).join('')
    writeFileSync(join(home, 'start.sh'), `exec tmux -L ${INNER} -f ${home}/tmux.conf new-session -s in${cwd(first)} '${first.command}'${split}${labels} \\; select-pane -t in:0.0\n`)
    program = `sh ${home}/start.sh`
  }
  let command = `env -i ${env.join(' ')} ${program}`
  // Cloud containers expose a host OAuth token at this path; hide it so only the fake key is used.
  const remote = '/home/claude/.claude/remote'
  if (existsSync(remote)) command = `unshare -m sh -c "mount -t tmpfs none ${remote} && cd '${project}' && exec ${command}"`
  tmux('kill-session', '-t', SESSION)
  tmux('new-session', '-d', '-s', SESSION, '-x', String(cols), '-y', String(rows), '-c', project, `${command}; sleep 600`)
  await settle(scene.shell ? /\$ $/m : new RegExp(Array(scene.panes?.length ?? 1).fill('for shortcuts').join('[\\s\\S]*')))
  await sleep(800)

  const snapshots: { t: number; screen: string }[] = []
  const start = performance.now()
  let done = false
  const poll = (async () => {
    let last = ''
    while (!done) {
      const now = tmux('capture-pane', '-t', SESSION, '-e', '-p', '-N')
      if (now !== last) snapshots.push({ t: (performance.now() - start) / 1000, screen: now })
      last = now
      await sleep(60)
    }
  })()

  await sleep(600)
  if (scene.shell) {
    await type(scene.shell)
    await settle(/for shortcuts/)
    await sleep(800)
  }
  for (const step of scene.inputs[lang]) {
    if ('pause' in step) await sleep(step.pause)
    else if ('key' in step) keys(step.pane, ...step.key.split(' '))
    else await type(step.text, step.pane)
    if ('text' in step || step.wait) await settle(step.wait)
    await sleep(500)
  }
  await sleep(1500)
  done = true
  await poll
  tmux('kill-session', '-t', SESSION)
  if (scene.panes) tmux('-L', INNER, 'kill-server')
  server.stop(true)
  // A refresh during the run rotates the token, so the lent sign-in goes back to where it came from.
  if (scene.chatgpt && auth) cpSync(join(home, '.codex/auth.json'), auth)
  rmSync(home, { recursive: true, force: true })

  const out = join(import.meta.dir, '../src/demos/recordings', `${name}.${lang}.json`)
  mkdirSync(join(out, '..'), { recursive: true })
  const rec = convert(snapshots, cols, rows)
  writeFileSync(out, `${JSON.stringify(rec)}\n`)
  console.log(`${out}: ${rec.frames.length} frames, ${(rec.frames.at(-1)![0] / 1000).toFixed(1)}s`)
}

const names = values.scene ? [values.scene] : Object.keys(SCENES)
for (const name of names) {
  const scene = SCENES[name as keyof typeof SCENES]
  if (!scene) throw new Error(`unknown scene ${name}; one of ${Object.keys(SCENES).join(', ')}`)
  for (const lang of values.lang ? [values.lang as Lang] : (['en', 'zh', 'hans'] as Lang[])) await record(name, scene, lang)
}
