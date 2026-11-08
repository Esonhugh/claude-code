import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binFor, CELLS, credentialsFromEnv, getCell, jwtExpiryMs, SUB_CELLS, secretValues } from './clis'

const KEY = 'sk-ant-test-placeholder-0000000000'
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const ACCESS = `${b64({ alg: 'none' })}.${b64({ exp: 2000000000 })}.signaturepart0123456789`

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-clis-'))
  const codex = path.join(dir, 'codex-auth.json')
  fs.writeFileSync(codex, JSON.stringify({ tokens: { access_token: ACCESS, refresh_token: 'refresh-placeholder-0000000000', account_id: 'acct' } }))
  const claude = path.join(dir, 'credentials.json')
  fs.writeFileSync(claude, JSON.stringify({ claudeAiOauth: { accessToken: 'oauth-access-placeholder-000000', refreshToken: 'oauth-refresh-placeholder-00000' } }))
  return { dir, creds: { orgKey: KEY, codexAuthFile: codex, claudeCredentialsFile: claude } }
}

describe('cells', () => {
  test('every product has both a Claude and a ChatGPT cell', () => {
    for (const p of ['fork', 'official', 'codex', 'opencode', 'pi', 'omp', 'dsh']) {
      const sides = new Set(CELLS.filter(c => c.product === p).map(c => c.side))
      if (p === 'codex') expect([...sides]).toEqual(['chatgpt'])
      else if (p === 'official') expect([...sides].sort()).toEqual(['claude', 'claude-key'])
      else expect(sides.has('chatgpt') && (sides.has('claude') || sides.has('claude-key'))).toBe(true)
    }
  })

  for (const cell of CELLS) {
    test(`${cell.id}: fresh HOME, no secret on argv, key only for key cells, web search off`, () => {
      const { dir, creds } = fixture()
      const home = path.join(dir, 'h')
      const ctx = { home, workspace: path.join(dir, 'w'), proxyPort: 9999, prompt: 'Do the task.', creds }
      cell.setupHome(ctx)
      const l = cell.launch('/bin/cli', ctx)
      const secrets = secretValues(creds)
      expect(l.argv.join(' ')).not.toContain(KEY)
      for (const s of secrets) expect(l.argv.join(' ')).not.toContain(s)
      expect(l.env.ANTHROPIC_API_KEY === KEY).toBe(cell.side === 'claude-key')
      const argv = l.argv.join(' ')
      const noWeb =
        argv.includes('--disallowedTools WebSearch,WebFetch') ||
        argv.includes('web_search="disabled"') ||
        (l.env.OPENCODE_CONFIG_CONTENT ?? '').includes('"websearch":"deny"') ||
        (argv.includes('--tools') && !argv.includes('web')) ||
        cell.product === 'pi' ||
        fs.readFileSync(path.join(home, 'dsh-patch.yml'), { encoding: 'utf8', flag: 'a+' }).includes('id: tool-web\n  disabled: true')
      expect(noWeb).toBe(true)
      expect(argv.includes('Do the task.') || l.stdin === 'Do the task.').toBe(true)
      // credential files written into HOME are private
      const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
      for (const f of walk(home)) if (/auth\.json|credentials/.test(f)) expect(fs.statSync(f).mode & 0o077).toBe(0)
      fs.rmSync(dir, { recursive: true })
    })
  }

  test('omp ChatGPT login is a row in its agent.db, never refreshed', () => {
    const { dir, creds } = fixture()
    const home = path.join(dir, 'h')
    CELLS.find(c => c.id === 'omp-openai')!.setupHome({ home, workspace: dir, proxyPort: 1, prompt: '', creds })
    const db = new Database(path.join(home, '.omp/agent/agent.db'))
    const row = db.query('select provider, data from auth_credentials').get() as { provider: string; data: string }
    db.close()
    expect(row.provider).toBe('openai-codex')
    expect(JSON.parse(row.data).expires).toBe(2000000000 * 1000)
    fs.rmSync(dir, { recursive: true })
  })

  test('Codex login copy has a fresh last_refresh, so Codex never rotates the shared refresh token', () => {
    const { dir, creds } = fixture()
    const home = path.join(dir, 'h')
    getCell('codex').setupHome({ home, workspace: dir, proxyPort: 1, prompt: '', creds })
    const auth = JSON.parse(fs.readFileSync(path.join(home, '.codex/auth.json'), 'utf8'))
    expect(Date.now() - Date.parse(auth.last_refresh)).toBeLessThan(60_000)
    expect(auth.tokens.refresh_token).toBe('refresh-placeholder-0000000000')
    fs.rmSync(dir, { recursive: true })
  })

  test('dsh: credential store on (headless turns it off), no permission prompts', () => {
    const { dir, creds } = fixture()
    const home = path.join(dir, 'h')
    const cell = getCell('dsh-openai')
    cell.setupHome({ home, workspace: dir, proxyPort: 1, prompt: '', creds })
    expect(fs.readFileSync(path.join(home, 'dsh-patch.yml'), 'utf8')).toContain('- id: credentials\n  disabled: false')
    expect(cell.launch('/bin/dsh', { home, workspace: dir, proxyPort: 1, prompt: 'x', creds }).env.DSH_PERMISSION_MODE).toBe('danger-full-access')
    fs.rmSync(dir, { recursive: true })
  })

  test('subagent cells keep their base cell and only extend the prompt', () => {
    const { dir, creds } = fixture()
    for (const sub of SUB_CELLS) {
      const base = getCell(sub.id.replace(/-sub$/, ''))
      expect([sub.product, sub.side, sub.model]).toEqual([base.product, base.side, base.model])
      const l = sub.launch('/bin/cli', { home: dir, workspace: dir, proxyPort: 1, prompt: 'Do the task.', creds })
      expect(l.stdin).toStartWith('Do the task.')
      expect(l.stdin).toContain('subagents in parallel')
    }
    fs.rmSync(dir, { recursive: true })
  })
})

test('jwt expiry, binary paths and credentials come from env', () => {
  expect(jwtExpiryMs(ACCESS)).toBe(2000000000000)
  expect(binFor('codex', {})).toBe('codex')
  expect(binFor('fork', {})).toBe(path.resolve('./built-claude'))
  expect(binFor('pi', { BENCH_BIN_PI: '/opt/pi' })).toBe('/opt/pi')
  const c = credentialsFromEnv({ CLAUDE_CODE_ORG_KEY: KEY, BENCH_CODEX_AUTH: '/nonexistent', BENCH_CLAUDE_CREDENTIALS: '/nonexistent' })
  expect(c).toEqual({ orgKey: KEY, claudeCredentialsFile: undefined, codexAuthFile: undefined, seedCatalogFile: undefined })
})
