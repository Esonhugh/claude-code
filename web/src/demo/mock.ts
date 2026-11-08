// A backend-free `claude web` for the project website: `fetch('/api/…')` and the
// session WebSocket are answered here with canned data, and every prompt gets a
// scripted turn (read a file, edit it, ask to run a command, report).
// Loaded before the app by src/demo/main.tsx; the real build never imports it.

type Json = Record<string, unknown>

const WORK_DIR = '/home/demo/projects/search-demo'
const VERSION = '2.1.297'
const now = Date.now()
const zh = (navigator.language || '').toLowerCase().startsWith('zh')

let provider: 'anthropic' | 'openai' = 'anthropic'
let seq = 0
const uid = (p = 'id') => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`

const MODELS = {
  anthropic: {
    model: 'claude-opus-5-5',
    models: [
      { value: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Most capable', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], contextWindowTiers: [128000, 200000, 500000, 1000000] },
      { value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Fast and capable', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], contextWindowTiers: [128000, 200000, 1000000] },
      { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest' },
    ],
  },
  openai: {
    model: 'gpt-6.1-sol',
    models: [
      { value: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', description: 'From your ChatGPT account catalog', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'], contextWindowTiers: [128000, 272000] },
      { value: 'gpt-6.1-sol-codex', displayName: 'GPT-6.1 Sol Codex', description: 'Coding model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], contextWindowTiers: [128000, 272000] },
    ],
  },
}

const PAST = [
  { id: 'demo-past-1', title: zh ? '整理 README 的安裝段落' : 'Tidy the README install section', cwd: WORK_DIR, lastModified: now - 3600_000, files: 1 },
  { id: 'demo-past-2', title: zh ? '為 slugify 補單元測試' : 'Add unit tests for slugify', cwd: '/home/demo/projects/utils', lastModified: now - 26 * 3600_000, files: 2 },
]
const created: { id: string; title: string; cwd: string; lastModified: number }[] = []

function account(): Json {
  return {
    kind: provider === 'anthropic' ? 'claude' : 'chatgpt',
    provider,
    name: 'Demo user',
    plan: provider === 'anthropic' ? 'Max' : 'Pro',
    keys: [],
    oauth: ['anthropic', 'openai'],
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// ---------- REST ----------

function route(method: string, url: URL, body: Json): Response {
  const p = url.pathname.replace(/^.*?\/api\//, '/api/')
  if (p === '/api/info') return json({ workspace: WORK_DIR, home: '/home/demo', version: VERSION, local: true })
  if (p === '/api/account' && method === 'GET') return json(account())
  if (p === '/api/account/oauth/use') {
    if (body.provider === 'openai' || body.provider === 'anthropic') provider = body.provider
    return json(account())
  }
  if (p.startsWith('/api/account')) return json(account())
  if (p === '/api/models') return json(MODELS[provider])
  if (p === '/api/settings') {
    return json({ uiName: 'EsonClaw', features: { autoCompact: true, gitInstructions: false, memoryExtraction: false, agentSummary: true, promptSuggestions: true }, daybreak: 'off', allow_local_network: false })
  }
  if (p === '/api/sidebar') {
    const sessions = [...created, ...PAST].map(s => ({ ...s, label: 'title' }))
    const folders: Record<string, number> = {}
    for (const s of sessions) folders[s.cwd] = (folders[s.cwd] ?? 0) + 1
    return json({ sessions, folders, more: false })
  }
  if (p === '/api/sessions' && method === 'POST') {
    const id = uid('demo')
    created.unshift({ id, title: zh ? '新會話' : 'New session', cwd: String(body.cwd || WORK_DIR), lastModified: Date.now() })
    return json({ session_id: id, work_dir: String(body.cwd || WORK_DIR) })
  }
  if (p === '/api/sessions') return json([])
  if (p === '/api/usage') {
    return json({ subscription_type: provider === 'anthropic' ? 'max' : 'pro', rate_limits: { five_hour: { utilization: 0.18 }, seven_day: { utilization: 0.41 } } })
  }
  if (p === '/api/projects') return json([])
  if (p === '/api/peers') return json({ peers: [] })
  if (p === '/api/prompt-history') return json({ prompts: [] })
  if (/^\/api\/(files\/[^/]+\/list|folder-files)$/.test(p)) {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    return json({ files: ['retrieval.py', 'index.py', 'run_tests.sh', 'README.md', 'tests/test_retrieval.py'].filter(f => f.includes(q)) })
  }
  const snippet = /^\/api\/history\/([^/]+)\/snippet$/.exec(p)
  if (snippet) return json({ snippet: zh ? '改好了，測試全部通過。' : 'Done. All tests pass.' })
  const history = /^\/api\/history\/([^/]+)\/messages$/.exec(p)
  if (history) {
    const past = PAST.find(s => s.id === decodeURIComponent(history[1]!))
    const messages = past ? pastTranscript(past.title) : []
    return json({ messages, start: 0, total: messages.length, cwd: past?.cwd ?? WORK_DIR, title: past?.title })
  }
  if (p.startsWith('/api/history/')) return json({ messages: [] })
  if (p.startsWith('/api/ext/')) return json(extAnswer(p.slice('/api/ext/'.length)))
  if (method !== 'GET') return json({ ok: true })
  console.info('[demo] no mock for', method, p)
  return json({})
}

function extAnswer(path: string): unknown {
  if (path === 'skills')
    return [
      { name: 'release-notes', display: 'release-notes', group: 'project', where: '.claude/skills', description: 'Draft release notes from merged PRs', on: true, toggleable: true },
      { name: 'dataviz', display: 'dataviz', group: 'builtin', where: 'built-in', description: 'Charts that read well in light and dark', on: true, toggleable: true },
    ]
  if (path.startsWith('skills/')) return { content: '# release-notes\n\nDraft release notes from merged PRs.' }
  if (path === 'memory') return { files: [], autoMemory: false, sqlite: false }
  if (path.startsWith('memory/search')) return { memory: [], sessions: [] }
  if (path === 'hooks') return { disabled: false, hooks: [] }
  if (path === 'plugins') return { installed: [], discover: [], marketplaces: [] }
  if (path === 'channels' || path === 'mods') return []
  if (path === 'stats')
    return { days: [], tokens: [], streaks: { current: 0, longest: 0 }, longestSessionMs: 0, hours: Array(24).fill(0), totalSessions: 0, codex: null }
  return {}
}

function pastTranscript(title: string): unknown[] {
  const u = uid('u')
  const a = uid('a')
  return [
    { type: 'user', uuid: u, isReplay: true, timestamp: new Date(now - 3600_000).toISOString(), message: { role: 'user', content: title } },
    { type: 'assistant', uuid: uid('p'), message: { id: a, role: 'assistant', model: MODELS[provider].model, content: [{ type: 'text', text: zh ? '已完成，這是一段示範紀錄。開一個新會話試試看實際的互動。' : 'Done. This is a sample transcript; start a new session to try the interactive flow.' }] } },
  ]
}

const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href)
  if (!url.pathname.includes('/api/')) return realFetch(input, init)
  let body: Json = {}
  try {
    body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : {}
  } catch {}
  await new Promise(r => setTimeout(r, 60))
  return route((init?.method ?? 'GET').toUpperCase(), url, body)
}

// ---------- session socket ----------

type Listener = (event: Event) => void

class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  readonly url: string
  private sessionId: string
  private pending = new Map<string, (response: Json) => void>()
  private timers: number[] = []
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    this.sessionId = decodeURIComponent(/\/sessions\/([^/]+)\/ws/.exec(this.url)?.[1] ?? 'demo')
    setTimeout(() => {
      this.readyState = 1
      this.fire(new Event('open'))
      this.emit(this.init())
    }, 80)
  }

  private fire(event: Event) {
    this.dispatchEvent(event)
    const handler = (this as unknown as Record<string, Listener | null>)[`on${event.type}`]
    handler?.call(this, event)
  }

  private emit(msg: Json) {
    if (this.readyState !== 1) return
    this.fire(new MessageEvent('message', { data: JSON.stringify(msg) + '\n' }))
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms))
  }

  private init(): Json {
    return {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      cwd: WORK_DIR,
      model: MODELS[provider].model,
      permissionMode: 'default',
      claude_code_version: VERSION,
      apiKeySource: 'none',
      tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Agent', 'Tmux', 'Monitor'],
      mcp_servers: [{ name: 'github', status: 'connected' }],
      skills: ['release-notes'],
      plugins: [],
      slash_commands: ['compact', 'context', 'goal', 'model', 'usage'],
    }
  }

  send(data: string) {
    for (const line of String(data).split('\n')) {
      if (!line.trim()) continue
      let msg: Json
      try {
        msg = JSON.parse(line) as Json
      } catch {
        continue
      }
      this.receive(msg)
    }
  }

  close() {
    this.timers.forEach(clearTimeout)
    this.readyState = 3
    this.fire(new CloseEvent('close', { code: 1000 }))
  }

  private receive(msg: Json) {
    if (msg.type === 'user') return this.turn(msg)
    if (msg.type === 'control_response') {
      const response = (msg.response ?? {}) as Json
      const settle = this.pending.get(String(response.request_id))
      if (settle) {
        this.pending.delete(String(response.request_id))
        settle(response)
      }
      return
    }
    if (msg.type === 'control_request') return this.control(msg)
  }

  private control(msg: Json) {
    const request = (msg.request ?? {}) as Json
    const id = String(msg.request_id)
    const ok = (response: Json = {}) => this.emit({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })
    switch (request.subtype) {
      case 'initialize':
        return ok({
          models: MODELS[provider].models,
          commands: [
            { name: 'goal', description: 'Keep working until a condition holds', argumentHint: '<condition>' },
            { name: 'context', description: 'Show context usage', argumentHint: '' },
            { name: 'compact', description: 'Summarize the conversation to free context', argumentHint: '' },
            { name: 'usage', description: 'Show usage and cost', argumentHint: '' },
          ],
          claude_code_version: VERSION,
          account: { email: 'demo@example.com', subscriptionType: provider === 'anthropic' ? 'max' : 'pro', apiProvider: provider === 'anthropic' ? 'firstParty' : 'openai' },
        })
      case 'get_settings':
        return ok({ effective: {}, applied: { model: MODELS[provider].model, effort: 'medium', autoCompactWindow: null } })
      case 'get_context_usage': {
        const total = 18400 + this.turns * 9200
        return ok({
          totalTokens: total,
          maxTokens: 1_000_000,
          percentage: Math.round((total / 1_000_000) * 100),
          isAutoCompactEnabled: true,
          categories: [
            { id: 'systemPrompt', tokens: 9400 },
            { id: 'systemTools', tokens: 6100 },
            { id: 'messages', tokens: total - 15500 },
          ],
        })
      }
      case 'get_usage':
        return ok({ session: { total_cost_usd: this.turns * 0.07, model_usage: {} }, subscription_type: 'max' })
      case 'rewind_points':
        return ok({ uuids: [] })
      case 'interrupt':
        this.timers.forEach(clearTimeout)
        this.timers = []
        ok()
        return this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [] })
      default:
        return ok()
    }
  }

  private turns = 0

  private assistant(id: string, content: Json[]) {
    this.emit({ type: 'assistant', uuid: uid('p'), session_id: this.sessionId, message: { id, role: 'assistant', model: MODELS[provider].model, content } })
  }

  private toolResult(toolUseId: string, text: string, extra: Json = {}) {
    this.emit({ type: 'user', uuid: uid('r'), session_id: this.sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }, ...extra })
  }

  // One scripted turn: Read, Edit (with a diff), Bash behind an approval, then a summary.
  private turn(msg: Json) {
    this.turns += 1
    const text = contentText((msg.message as Json | undefined)?.content)
    this.emit({ type: 'user', uuid: msg.uuid ?? uid('u'), isReplay: true, session_id: this.sessionId, message: { role: 'user', content: text } })
    const a1 = uid('msg')
    const read = uid('toolu')
    const edit = uid('toolu')
    const bash = uid('toolu')
    const L = (en: string, z: string) => (zh ? z : en)
    const usePatch = provider === 'openai'
    this.later(600, () =>
      this.assistant(a1, [
        { type: 'text', text: L(`This is a demo with scripted replies, so I will run the same small task whatever you asked ("${text.slice(0, 60)}"). First, the current implementation.`, `這是腳本化回覆的示範，不管你問什麼（「${text.slice(0, 40)}」）都會跑同一個小任務。先看一下目前的實作。`) },
        { type: 'tool_use', id: read, name: 'Read', input: { file_path: `${WORK_DIR}/retrieval.py` } },
      ]),
    )
    this.later(1300, () => this.toolResult(read, '1\tfrom index import Index\n2\t\n3\tTOP_K = 10\n4\t\n5\t\n6\tdef search(index: Index, query: str):'))
    this.later(2000, () =>
      this.assistant(a1, [
        { type: 'text', text: L('TOP_K is on line 3; raising it to 20.', 'TOP_K 在第 3 行，改成 20。') },
        usePatch
          ? { type: 'tool_use', id: edit, name: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: retrieval.py\n@@\n-TOP_K = 10\n+TOP_K = 20\n*** End Patch' } }
          : { type: 'tool_use', id: edit, name: 'Edit', input: { file_path: `${WORK_DIR}/retrieval.py`, old_string: 'TOP_K = 10', new_string: 'TOP_K = 20' } },
      ]),
    )
    this.later(2700, () =>
      this.toolResult(edit, L('The file retrieval.py has been updated.', '已更新 retrieval.py。'), {
        tool_use_result: {
          filePath: `${WORK_DIR}/retrieval.py`,
          structuredPatch: [{ oldStart: 1, oldLines: 6, newStart: 1, newLines: 6, lines: [' from index import Index', ' ', '-TOP_K = 10', '+TOP_K = 20', ' ', ' ', ' def search(index: Index, query: str):'] }],
        },
      }),
    )
    this.later(3300, () => {
      this.assistant(a1, [
        { type: 'text', text: L('Running the tests.', '跑一下測試。') },
        { type: 'tool_use', id: bash, name: 'Bash', input: { command: 'sh run_tests.sh', description: 'Run the test suite' } },
      ])
      const requestId = uid('perm')
      this.pending.set(requestId, response => this.afterApproval(a1, bash, response))
      this.emit({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'sh run_tests.sh', description: 'Run the test suite' }, tool_use_id: bash, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'sh run_tests.sh' }], behavior: 'allow', destination: 'session' }] },
      })
    })
  }

  private afterApproval(a1: string, bash: string, response: Json) {
    const L = (en: string, z: string) => (zh ? z : en)
    const body = (response.response ?? {}) as Json
    if (body.behavior === 'deny') {
      this.toolResult(bash, L('The user denied this command.', '使用者拒絕了這個命令。'))
      this.later(500, () => {
        this.assistant(a1, [{ type: 'text', text: L('OK, I left the tests alone. The edit to retrieval.py is in place.', '好，不跑測試了。retrieval.py 的修改已完成。') }])
        this.finish()
      })
      return
    }
    this.later(700, () => this.toolResult(bash, '......\n6 passed in 0.41s'))
    this.later(1300, () => {
      this.assistant(a1, [
        {
          type: 'text',
          text: L(
            'Done. All tests pass.\n\n| Item | Before | After |\n| --- | --- | --- |\n| `TOP_K` | 10 | 20 |\n| Tests | — | 6 passed |\n\nTry the side panel (Status, Files, Agents), the model menu, or **Account → Authentication** to switch to a ChatGPT account.',
            '改好了，測試全部通過。\n\n| 項目 | 改動前 | 改動後 |\n| --- | --- | --- |\n| `TOP_K` | 10 | 20 |\n| 測試 | — | 6 passed |\n\n可以試試右側面板（Status、Files、Agents）、模型選單，或從帳號選單的 Authentication 切到 ChatGPT 帳號。',
          ),
        },
      ])
      this.finish()
    })
  }

  private finish() {
    this.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: this.sessionId,
      total_cost_usd: this.turns * 0.07,
      usage: { input_tokens: 1200, output_tokens: 640, cache_read_input_tokens: 15800 * this.turns, cache_creation_input_tokens: 2100 },
      result: '',
    })
    const s = created.find(c => c.id === this.sessionId)
    if (s) {
      s.title = zh ? '檢查 retrieval.py，把 TOP_K 改成 20' : 'Check retrieval.py, set TOP_K to 20'
      s.lastModified = Date.now()
    }
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && (c as Json).type === 'text' ? String((c as Json).text) : '')).join('')
  return ''
}

;(window as unknown as { WebSocket: unknown }).WebSocket = DemoSocket
