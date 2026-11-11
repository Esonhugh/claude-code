// Records the real CLI in tmux for the site's tour and writes src/demos/recordings/<scene>.<lang>.json.
// Usage (from site/): bun record/record.ts [--binary ../built-claude] [--lang en|zh|hans]
// The model side is scripted by goal-api.ts; everything on screen is drawn by the real binary.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { Lang } from '../src/demos/i18n'
import { convert } from './convert'
import { goalSteps, serveGoalApi } from './goal-api'

const { values } = parseArgs({ options: { binary: { type: 'string', default: '../built-claude' }, lang: { type: 'string' } } })
const BINARY = resolve(values.binary!)
// Marking this version's release notes as seen keeps the startup banner compact.
const VERSION = Bun.spawnSync([BINARY, '--version']).stdout.toString().split(' ')[0]
const COLS = 80
const ROWS = 22
const PORT = 18801
const SESSION = 'site-record'
// The fake API key must be pre-approved by its last 20 characters, so it is exactly 20 long.
const API_KEY = 'demo0000000000000000'

const PROMPTS: Record<Lang, string> = {
  en: 'the parser tests keep failing. Keep fixing until every test passes',
  zh: 'parser 的測試一直掛，幫我修到全部測試通過為止',
  hans: 'parser 的测试一直挂，帮我修到全部测试通过为止',
}

const FIXTURE: Record<string, string> = {
  'package.json': '{ "name": "search-demo", "private": true, "type": "module", "scripts": { "test": "bun test" } }\n',
  'src/parser.ts': `export type Query = { terms: string[]; phrases: string[]; exclude: string[] }

export function parseQuery(input: string): Query {
  const q: Query = { terms: [], phrases: [], exclude: [] }
  const re = /"([^"]*)"|(\\S+)/g
  for (const m of input.matchAll(re)) {
    if (m[1] !== undefined) q.phrases.push(m[1])
    else q.terms.push(m[2])
  }
  return q
}
`,
  'test/parser.test.ts': `import { expect, test } from 'bun:test'
import { parseQuery } from '../src/parser'

test('splits terms', () => expect(parseQuery('red fox').terms).toEqual(['red', 'fox']))
test('reads phrases', () => expect(parseQuery('"red fox" den').phrases).toEqual(['red fox']))
test('keeps other terms', () => expect(parseQuery('"red fox" den').terms).toEqual(['den']))
test('excludes -terms', () => expect(parseQuery('fox -dog').exclude).toEqual(['dog']))
test('-terms are not terms', () => expect(parseQuery('fox -dog').terms).toEqual(['fox']))
test('lowercases terms', () => expect(parseQuery('Red FOX').terms).toEqual(['red', 'fox']))
`,
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const tmux = (...args: string[]) => Bun.spawnSync(['tmux', ...args]).stdout.toString()

async function record(lang: Lang) {
  const home = mkdtempSync(join(tmpdir(), 'site-record-'))
  const project = join(home, 'projects/search-demo')
  for (const [path, body] of Object.entries(FIXTURE)) {
    mkdirSync(join(project, path, '..'), { recursive: true })
    writeFileSync(join(project, path), body)
  }
  mkdirSync(join(home, '.claude'))
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
      projects: { [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  )
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(bun test)', 'Edit', 'Read'] } }))

  const server = serveGoalApi(PORT, goalSteps(lang, project))
  const env = [
    `PATH=${process.env.PATH}`,
    `HOME=${home}`,
    'TERM=xterm-256color',
    'COLORTERM=truecolor',
    'LANG=C.UTF-8',
    'IS_SANDBOX=1',
    'ENABLE_TOOL_SEARCH=false',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    `ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}`,
    `ANTHROPIC_API_KEY=${API_KEY}`,
  ]
  let command = `env -i ${env.join(' ')} '${BINARY}' --model claude-sonnet-5-5`
  // Cloud containers expose a host OAuth token at this path; hide it so only the fake key is used.
  const remote = '/home/claude/.claude/remote'
  if (existsSync(remote)) command = `unshare -m sh -c "mount -t tmpfs none ${remote} && cd '${project}' && exec ${command}"`
  tmux('kill-session', '-t', SESSION)
  tmux('new-session', '-d', '-s', SESSION, '-x', String(COLS), '-y', String(ROWS), '-c', project, `${command}; sleep 600`)

  for (let i = 0; i < 60 && !tmux('capture-pane', '-t', SESSION, '-p').includes('for shortcuts'); i++) await sleep(500)
  await sleep(1000)

  const snapshots: { t: number; screen: string }[] = []
  const start = performance.now()
  let done = false
  const poll = (async () => {
    let last = ''
    while (!done) {
      const screen = tmux('capture-pane', '-t', SESSION, '-e', '-p')
      if (screen !== last) snapshots.push({ t: (performance.now() - start) / 1000, screen })
      last = screen
      await sleep(60)
    }
  })()

  await sleep(600)
  for (const ch of PROMPTS[lang]) {
    tmux('send-keys', '-t', SESSION, '-l', ch)
    await sleep(30 + Math.random() * 40)
  }
  await sleep(500)
  tmux('send-keys', '-t', SESSION, 'Enter')
  for (let i = 0; i < 120 && !/✻ \S+ for \d+s/.test(tmux('capture-pane', '-t', SESSION, '-p')); i++) await sleep(500)
  await sleep(1500)
  done = true
  await poll
  tmux('kill-session', '-t', SESSION)
  server.stop(true)
  rmSync(home, { recursive: true, force: true })

  const out = join(import.meta.dir, '../src/demos/recordings', `goal.${lang}.json`)
  mkdirSync(join(out, '..'), { recursive: true })
  const rec = convert(snapshots, COLS, ROWS)
  writeFileSync(out, `${JSON.stringify(rec)}\n`)
  console.log(`${out}: ${rec.frames.length} frames, ${(rec.frames.at(-1)![0] / 1000).toFixed(1)}s`)
}

for (const lang of values.lang ? [values.lang as Lang] : (['en', 'zh', 'hans'] as Lang[])) await record(lang)
