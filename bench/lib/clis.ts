import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Account side a cell runs on. Claude subscription = OAuth credentials file;
// Claude key = the org API key from CLAUDE_CODE_ORG_KEY; ChatGPT = Codex login file.
export type Side = 'claude' | 'claude-key' | 'chatgpt'
export const SIDE_LABEL: Record<Side, string> = { claude: 'Claude', 'claude-key': 'Claude API', chatgpt: 'ChatGPT' }

export const PRODUCTS = ['fork', 'official', 'codex', 'opencode', 'pi', 'omp', 'dsh'] as const
export type Product = (typeof PRODUCTS)[number]

// Where each binary comes from. Defaults match the Makefile (./built-claude,
// ./official-claude); third-party CLIs are looked up on PATH.
export const BIN_ENV: Record<Product, [string, string]> = {
  fork: ['BENCH_BIN_FORK', './built-claude'],
  official: ['BENCH_BIN_OFFICIAL', './official-claude'],
  codex: ['BENCH_BIN_CODEX', 'codex'],
  opencode: ['BENCH_BIN_OPENCODE', 'opencode'],
  pi: ['BENCH_BIN_PI', 'pi'],
  omp: ['BENCH_BIN_OMP', 'omp'],
  dsh: ['BENCH_BIN_DSH', 'dsh'],
}

export const MODELS = {
  claude: process.env.BENCH_MODEL_CLAUDE ?? 'claude-sonnet-5-5',
  chatgpt: process.env.BENCH_MODEL_CHATGPT ?? 'gpt-6.1-sol',
}

export type Credentials = {
  orgKey?: string // value, held in memory only
  claudeCredentialsFile?: string // path
  codexAuthFile?: string // path
  seedCatalogFile?: string // path: warm ChatGPT model catalog for the fork, like a returning user
}

export type RunContext = { home: string; workspace: string; proxyPort: number; prompt: string; creds: Credentials }

export type Launch = { argv: string[]; env: Record<string, string>; stdin?: string; exitAfter?: string }

export type Cell = {
  id: string
  product: Product
  side: Side
  model: string
  setupHome(ctx: RunContext): void
  launch(bin: string, ctx: RunContext): Launch
}

const write = (file: string, data: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data, { mode: 0o600 })
}

type CodexTokens = { access_token: string; refresh_token: string; account_id?: string }

export function readCodexTokens(file: string): CodexTokens {
  return JSON.parse(fs.readFileSync(file, 'utf8')).tokens
}

// Expiry from the JWT itself, so no client ever refreshes: a refresh rotates the
// shared refresh token and breaks the login for every other run.
export function jwtExpiryMs(token: string): number {
  const part = token.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).exp * 1000
}

const piOAuth = (t: CodexTokens) => ({
  type: 'oauth',
  access: t.access_token,
  refresh: t.refresh_token,
  expires: jwtExpiryMs(t.access_token),
  accountId: t.account_id,
})

function need<T>(v: T | undefined, what: string): T {
  if (!v) throw new Error(`missing credential: ${what}`)
  return v
}

// Claude Code family (fork and official): onboarding done, workspace trusted, bypass mode.
function claudeHome(ctx: RunContext, side: Side, settings: Record<string, unknown> = {}) {
  const cfg: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    theme: 'dark',
    projects: { [ctx.workspace]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }
  if (side === 'chatgpt' && ctx.creds.seedCatalogFile) Object.assign(cfg, JSON.parse(fs.readFileSync(ctx.creds.seedCatalogFile, 'utf8')))
  write(path.join(ctx.home, '.claude.json'), JSON.stringify(cfg))
  write(
    path.join(ctx.home, '.claude', 'settings.json'),
    JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: { defaultMode: 'bypassPermissions' }, ...settings }),
  )
  if (side === 'claude') write(path.join(ctx.home, '.claude', '.credentials.json'), fs.readFileSync(need(ctx.creds.claudeCredentialsFile, 'Claude credentials file'), 'utf8'))
  if (side === 'chatgpt') codexHome(ctx)
}

// last_refresh = now: Codex refreshes a login whose last refresh is ~8 days old, which would rotate the shared refresh token.
function codexHome(ctx: RunContext) {
  const auth = JSON.parse(fs.readFileSync(need(ctx.creds.codexAuthFile, 'Codex auth file'), 'utf8'))
  write(path.join(ctx.home, '.codex', 'auth.json'), JSON.stringify({ ...auth, last_refresh: new Date().toISOString() }))
}

const keyEnv = (ctx: RunContext) => ({ ANTHROPIC_API_KEY: need(ctx.creds.orgKey, 'CLAUDE_CODE_ORG_KEY') })

// Prompt goes on stdin: --disallowedTools is variadic and would swallow a trailing prompt.
function claudeCell(
  id: string,
  product: 'fork' | 'official',
  side: Side,
  variant: { settings?: Record<string, unknown>; env?: Record<string, string> } = {},
): Cell {
  const model = side === 'chatgpt' ? MODELS.chatgpt : MODELS.claude
  return {
    id,
    product,
    side,
    model,
    setupHome: ctx => claudeHome(ctx, side, variant.settings),
    launch: (bin, ctx) => ({
      argv: [bin, '-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--disallowedTools', 'WebSearch,WebFetch'],
      env: {
        ...(side === 'claude-key' ? keyEnv(ctx) : {}),
        ...(side === 'chatgpt' ? { CLAUDE_CODE_USE_OPENAI: '1', CODEX_HOME: path.join(ctx.home, '.codex') } : {}),
        ...variant.env,
      },
      stdin: ctx.prompt,
    }),
  }
}

const OPENCODE_NO_WEB = JSON.stringify({ permission: { webfetch: 'deny', websearch: 'deny' } })
const OMP_TOOLS = 'read,bash,edit,eval,glob,grep,task,wait,todo,write' // default set minus web_search

function opencodeCell(side: 'claude-key' | 'chatgpt'): Cell {
  const model = side === 'chatgpt' ? MODELS.chatgpt : MODELS.claude
  return {
    id: side === 'chatgpt' ? 'opencode-openai' : 'opencode-claude',
    product: 'opencode',
    side,
    model,
    setupHome: ctx => {
      if (side !== 'chatgpt') return
      const t = readCodexTokens(need(ctx.creds.codexAuthFile, 'Codex auth file'))
      write(path.join(ctx.home, '.local/share/opencode/auth.json'), JSON.stringify({ openai: piOAuth(t) }))
    },
    launch: (bin, ctx) => ({
      argv: [bin, 'run', '--format', 'json', '--auto', '-m', `${side === 'chatgpt' ? 'openai' : 'anthropic'}/${model}`, ctx.prompt],
      env: {
        ...(side === 'claude-key' ? keyEnv(ctx) : {}),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_SHARE: '1',
        OPENCODE_CONFIG_CONTENT: OPENCODE_NO_WEB,
      },
    }),
  }
}

function piCell(side: 'claude-key' | 'chatgpt'): Cell {
  const model = side === 'chatgpt' ? MODELS.chatgpt : MODELS.claude
  return {
    id: side === 'chatgpt' ? 'pi-openai' : 'pi-claude',
    product: 'pi',
    side,
    model,
    setupHome: ctx => {
      if (side !== 'chatgpt') return
      const t = readCodexTokens(need(ctx.creds.codexAuthFile, 'Codex auth file'))
      write(path.join(ctx.home, '.pi/agent/auth.json'), JSON.stringify({ 'openai-codex': piOAuth(t) }))
    },
    launch: (bin, ctx) => ({
      argv: [bin, '-p', ctx.prompt, '--provider', side === 'chatgpt' ? 'openai-codex' : 'anthropic', '--model', model, '--mode', 'json'],
      env: { ...(side === 'claude-key' ? keyEnv(ctx) : {}), PI_TELEMETRY: '0' },
    }),
  }
}

function ompCell(side: 'claude-key' | 'chatgpt'): Cell {
  const model = side === 'chatgpt' ? MODELS.chatgpt : MODELS.claude
  return {
    id: side === 'chatgpt' ? 'omp-openai' : 'omp-claude',
    product: 'omp',
    side,
    model,
    setupHome: ctx => {
      if (side !== 'chatgpt') return
      const t = readCodexTokens(need(ctx.creds.codexAuthFile, 'Codex auth file'))
      const db = path.join(ctx.home, '.omp/agent/agent.db')
      fs.mkdirSync(path.dirname(db), { recursive: true })
      fs.copyFileSync(path.join(import.meta.dir, 'seed', 'omp-agent.db'), db)
      const conn = new Database(db)
      conn.run("insert into auth_credentials(provider, credential_type, data) values ('openai-codex', 'oauth', ?)", [
        JSON.stringify(piOAuth(t)),
      ])
      conn.close()
    },
    launch: (bin, ctx) => ({
      argv: [bin, '-p', ctx.prompt, '--model', `${side === 'chatgpt' ? 'openai-codex' : 'anthropic'}/${model}`, '--mode', 'json', '--no-title', '--auto-approve', '--tools', OMP_TOOLS],
      env: { ...(side === 'claude-key' ? keyEnv(ctx) : {}), PI_TELEMETRY: '0', PI_PROXY: `http://127.0.0.1:${ctx.proxyPort}` },
    }),
  }
}

function dshCell(side: 'claude-key' | 'chatgpt'): Cell {
  const model = side === 'chatgpt' ? MODELS.chatgpt : MODELS.claude
  const provider = side === 'chatgpt' ? 'openai-codex' : 'anthropic'
  const patch = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    side === 'chatgpt' ? '      openai-codex: {}' : '      anthropic:\n        apiKeyEnv: ANTHROPIC_API_KEY',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${provider}`,
    `    model: ${model}`,
    '- id: tool-web',
    '  disabled: true',
    // headless disables the credential store; the ChatGPT login is read from it
    '- id: credentials',
    '  disabled: false',
    '- id: authorization',
    '  disabled: false',
    '',
  ].join('\n')
  return {
    id: side === 'chatgpt' ? 'dsh-openai' : 'dsh-claude',
    product: 'dsh',
    side,
    model,
    setupHome: ctx => {
      write(path.join(ctx.home, 'dsh-patch.yml'), patch)
      if (side !== 'chatgpt') return
      const t = readCodexTokens(need(ctx.creds.codexAuthFile, 'Codex auth file'))
      // refresh is a dummy so dsh can never rotate the shared refresh token
      write(
        path.join(ctx.home, '.dsh', '.credentials.yaml'),
        [
          'version: 1',
          'records:',
          '  llm-pi-ai/openai-codex:',
          '    kind: grant',
          '    payload:',
          '      type: oauth',
          `      access: ${t.access_token}`,
          '      refresh: dummy-no-refresh',
          `      expires: ${jwtExpiryMs(t.access_token)}`,
          `      accountId: ${t.account_id}`,
          '',
        ].join('\n'),
      )
    },
    launch: (bin, ctx) => ({
      argv: [bin, '--profile', 'headless', '--patch', path.join(ctx.home, 'dsh-patch.yml'), '--json', ctx.prompt],
      // the other cells run without permission prompts too; dsh's default sandbox only writes inside the cwd
      env: { ...(side === 'claude-key' ? keyEnv(ctx) : {}), DSH_PERMISSION_MODE: 'danger-full-access' },
      ...(side === 'chatgpt' ? { exitAfter: '"type":"final"' } : {}),
    }),
  }
}

export const CELLS: Cell[] = [
  claudeCell('fork-claude', 'fork', 'claude'),
  claudeCell('fork-claude-key', 'fork', 'claude-key'),
  claudeCell('fork-openai', 'fork', 'chatgpt'),
  claudeCell('official', 'official', 'claude'),
  claudeCell('official-key', 'official', 'claude-key'),
  {
    id: 'codex',
    product: 'codex',
    side: 'chatgpt',
    model: MODELS.chatgpt,
    setupHome: codexHome,
    launch: (bin, ctx) => ({
      argv: [bin, 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'web_search="disabled"', ctx.prompt],
      env: { CODEX_HOME: path.join(ctx.home, '.codex') },
    }),
  },
  opencodeCell('chatgpt'),
  opencodeCell('claude-key'),
  piCell('chatgpt'),
  piCell('claude-key'),
  ompCell('chatgpt'),
  ompCell('claude-key'),
  dshCell('chatgpt'),
  dshCell('claude-key'),
]

// Multi-agent cells: same CLI and account, the prompt asks for parallel subagents.
const SUB_SUFFIX = '\n\nUse the Agent tool to launch subagents in parallel for independent parts of this task (at least two), then check the combined result yourself before you finish.'
const subCell = (base: Cell): Cell => ({ ...base, id: `${base.id}-sub`, launch: (bin, ctx) => base.launch(bin, { ...ctx, prompt: ctx.prompt + SUB_SUFFIX }) })
export const SUB_CELLS: Cell[] = ['fork-claude-key', 'official-key', 'fork-openai'].map(id => subCell(CELLS.find(c => c.id === id)!))

// Compaction A/B: a 100k auto-compact window makes long tasks compact; -keep
// retains ~20k tokens of recent messages verbatim (codex-style retention).
const AC_ENV = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000' }
const KEEP_RECENT = { compact: { mode: 'codex', codex: { keepPostCompactAttachments: true } } }
export const COMPACT_CELLS: Cell[] = [
  claudeCell('fork-claude-ac', 'fork', 'claude', { env: AC_ENV }),
  claudeCell('fork-claude-ac-keep', 'fork', 'claude', { env: AC_ENV, settings: KEEP_RECENT }),
]

// Memory A/B: the fork's SQLite FTS5 recall (SearchMemory) instead of MEMORY.md in context.
const SQLITE_MEMORY = { memory: { sqlite: { enabled: true } } }
export const MEMORY_CELLS: Cell[] = [
  claudeCell('fork-claude-key-sqlite', 'fork', 'claude-key', { settings: SQLITE_MEMORY }),
  // Effort pinned to high, for builds whose -p default is medium (fork before #1095, official).
  claudeCell('fork-claude-key-high', 'fork', 'claude-key', { env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } }),
  claudeCell('fork-claude-key-sqlite-high', 'fork', 'claude-key', { settings: SQLITE_MEMORY, env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } }),
  claudeCell('official-key-high', 'official', 'claude-key', { env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } }),
  claudeCell('fork-openai-sqlite', 'fork', 'chatgpt', { settings: SQLITE_MEMORY }),
]

export function getCell(id: string): Cell {
  const extra = [...SUB_CELLS, ...COMPACT_CELLS, ...MEMORY_CELLS]
  const c = CELLS.find(x => x.id === id) ?? extra.find(x => x.id === id)
  if (!c) throw new Error(`unknown cell ${id}; known: ${[...CELLS, ...extra].map(x => x.id).join(', ')}`)
  return c
}

export function selectCells(spec: string): Cell[] {
  return spec === 'all' ? CELLS : spec.split(',').map(getCell)
}

export function binFor(product: Product, env = process.env): string {
  const [name, fallback] = BIN_ENV[product]
  const bin = env[name] ?? fallback
  // Runs start in their own workspace, so a relative path is taken from where bench was launched.
  return bin.includes('/') ? path.resolve(bin) : bin
}

// Credentials come only from the environment: a key value, or paths to login files.
export function credentialsFromEnv(env = process.env): Credentials {
  const home = os.homedir()
  const existing = (p: string | undefined) => (p && fs.existsSync(p) ? p : undefined)
  return {
    orgKey: env.CLAUDE_CODE_ORG_KEY || undefined,
    claudeCredentialsFile: existing(env.BENCH_CLAUDE_CREDENTIALS ?? path.join(home, '.claude', '.credentials.json')),
    codexAuthFile: existing(env.BENCH_CODEX_AUTH ?? path.join(home, '.codex', 'auth.json')),
    seedCatalogFile: existing(env.BENCH_SEED_CATALOG),
  }
}

// Every secret value a run could leak, for the raw-log scan.
export function secretValues(creds: Credentials): string[] {
  const out: string[] = []
  if (creds.orgKey) out.push(creds.orgKey)
  if (creds.codexAuthFile) {
    const t = readCodexTokens(creds.codexAuthFile)
    out.push(t.access_token, t.refresh_token)
  }
  if (creds.claudeCredentialsFile) {
    const o = JSON.parse(fs.readFileSync(creds.claudeCredentialsFile, 'utf8')).claudeAiOauth ?? {}
    if (o.accessToken) out.push(o.accessToken)
    if (o.refreshToken) out.push(o.refreshToken)
  }
  return out.filter(v => typeof v === 'string' && v.length >= 16)
}
