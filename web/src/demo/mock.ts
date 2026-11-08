// A backend-free `claude web` for the project website: `fetch('/api/…')` and the
// session WebSocket are answered here with canned data, and every prompt gets a
// scripted turn from SCENARIOS (bug fix, feature with todos, parallel agents, /goal).
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
  if (p === '/api/peers') return json({ peers: [{ name: 'docs-writer', ref: 'docs-writer', session_id: 'demo-peer-1', pid: 4242, kind: 'interactive', status: 'idle', address: 'uds:/tmp/claude-demo/docs-writer.sock' }] })
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
  if (path === 'channels')
    return [
      { name: 'telegram', displayName: 'Telegram', plugin: 'telegram@claude-plugins-official', server: 'plugin:telegram:telegram', pluginEnabled: true, def: true },
      { name: 'fakechat', displayName: 'Fakechat', plugin: 'fakechat@claude-plugins-official', server: 'plugin:fakechat:fakechat', pluginEnabled: true, def: false },
    ]
  if (path === 'mods')
    return [
      { id: 'blast-radius', plugin: 'blast-radius', on: true, description: 'Lists what rm -r would delete and asks before it runs', file: 'mods/blast-radius.ts', editable: true, events: ['PreToolUse'], surfaces: ['toast', 'dialog'] },
      { id: 'token-meter', plugin: 'token-meter', on: true, description: 'Context and cost in the status line', file: 'mods/token-meter.ts', editable: true, events: ['Stop'], surfaces: ['status'] },
    ]
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
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href)
  if (!url.pathname.includes('/api/')) return realFetch(input, init)
  let body: Json = {}
  try {
    body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : {}
  } catch {}
  await new Promise(r => setTimeout(r, 60))
  return route((init?.method ?? 'GET').toUpperCase(), url, body)
}) as typeof fetch

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
        this.epoch += 1
        this.timers.forEach(clearTimeout)
        this.timers = []
        ok()
        return this.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [] })
      default:
        return ok()
    }
  }

  private turns = 0
  // Bumped by interrupt and close so a running script stops at its next step.
  private epoch = 0

  private wait(ms: number): Promise<void> {
    const epoch = this.epoch
    return new Promise((resolve, reject) =>
      this.later(ms, () => (epoch === this.epoch && this.readyState === 1 ? resolve() : reject(new Error('stopped')))),
    )
  }

  // One model call, streamed the way the CLI streams it: text and thinking arrive in chunks, tool input in one piece.
  private async say(blocks: Json[]) {
    const id = uid('msg')
    const model = MODELS[provider].model
    const stream = (event: Json) => this.emit({ type: 'stream_event', session_id: this.sessionId, event })
    stream({ type: 'message_start', message: { id, role: 'assistant', model, content: [] } })
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'text' || block.type === 'thinking') {
        const key = block.type as 'text' | 'thinking'
        stream({ type: 'content_block_start', index, content_block: { type: key, [key]: '' } })
        const full = String(block[key])
        for (let i = 0; i < full.length; ) {
          const n = 3 + Math.floor(Math.random() * 6)
          stream({ type: 'content_block_delta', index, delta: key === 'text' ? { type: 'text_delta', text: full.slice(i, i + n) } : { type: 'thinking_delta', thinking: full.slice(i, i + n) } })
          i += n
          await this.wait(key === 'text' ? 22 : 12)
        }
      } else {
        stream({ type: 'content_block_start', index, content_block: { ...block, input: {} } })
        await this.wait(150)
        stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      }
      stream({ type: 'content_block_stop', index })
      await this.wait(120)
    }
    this.emit({ type: 'assistant', uuid: uid('p'), session_id: this.sessionId, message: { id, role: 'assistant', model, content: blocks } })
  }

  private toolResult(toolUseId: string, text: string, extra: Json = {}, isError = false) {
    this.emit({
      type: 'user',
      uuid: uid('r'),
      session_id: this.sessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, ...(isError && { is_error: true }) }] },
      ...extra,
    })
  }

  private system(subtype: string, fields: Json) {
    this.emit({ type: 'system', subtype, uuid: uid('s'), session_id: this.sessionId, ...fields })
  }

  // Asks the page for permission like the CLI does; resolves true when allowed.
  private ask(toolUseId: string, toolName: string, input: Json, rule: string): Promise<boolean> {
    return new Promise(resolve => {
      const requestId = uid('perm')
      this.pending.set(requestId, response => resolve(((response.response ?? {}) as Json).behavior !== 'deny'))
      this.emit({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: toolUseId, permission_suggestions: [{ type: 'addRules', rules: [{ toolName, ruleContent: rule }], behavior: 'allow', destination: 'session' }] },
      })
    })
  }

  private turn(msg: Json) {
    this.turns += 1
    const text = contentText((msg.message as Json | undefined)?.content)
    this.emit({ type: 'user', uuid: msg.uuid ?? uid('u'), isReplay: true, session_id: this.sessionId, message: { role: 'user', content: text } })
    const scenario = pickScenario(text, this.turns)
    this.epoch += 1
    SCENARIOS[scenario].run(this, text).then(
      () => this.finish(SCENARIOS[scenario].title()),
      () => {},
    )
  }

  private finish(title: string) {
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
      if (this.turns === 1) s.title = title
      s.lastModified = Date.now()
    }
  }

  // The pieces the scenarios below are written in.
  get api() {
    return {
      wait: (ms: number) => this.wait(ms),
      say: (blocks: Json[]) => this.say(blocks),
      result: (id: string, text: string, extra?: Json, isError?: boolean) => this.toolResult(id, text, extra, isError),
      system: (subtype: string, fields: Json) => this.system(subtype, fields),
      ask: (id: string, tool: string, input: Json, rule: string) => this.ask(id, tool, input, rule),
      // A message that reaches the session from outside: a channel or another session.
      inbound: (text: string) => this.emit({ type: 'user', uuid: uid('u'), isReplay: true, session_id: this.sessionId, message: { role: 'user', content: text } }),
      status: (plugin: string, text: string) => this.system('ui_status', { plugin, text }),
      toast: (plugin: string, text: string) => this.system('ui_toast', { plugin, text, timeout_ms: 6000 }),
    }
  }
}

// ---------- scripted scenarios ----------

const L = (en: string, z: string) => (zh ? z : en)
const tool = (name: string, input: Json) => ({ type: 'tool_use', id: uid('toolu'), name, input })
const patch = (lines: string[], oldStart = 1, type?: string) => ({
  tool_use_result: { ...(type && { type }), filePath: '', structuredPatch: [{ oldStart, oldLines: lines.filter(l => !l.startsWith('+')).length, newStart: oldStart, newLines: lines.filter(l => !l.startsWith('-')).length, lines }] },
})
const editTool = (file: string, oldText: string, newText: string, patchText: string) =>
  provider === 'openai'
    ? tool('apply_patch', { input: `*** Begin Patch\n*** Update File: ${file}\n${patchText}\n*** End Patch` })
    : tool('Edit', { file_path: `${WORK_DIR}/${file}`, old_string: oldText, new_string: newText })
const NEXT = () =>
  L(
    '\n\nSend another message for the next scenario, or start one by name: **fix**, **feature**, **agents**, **/goal**, **channels**, **mods**.',
    '\n\n再送一則訊息會跑下一個情境，也可以直接點名：**fix**、**feature**、**agents**、**/goal**、**channels**、**mods**。',
  )

type Api = DemoSocket['api']
type Scenario = { title: () => string; run: (socket: DemoSocket, text: string) => Promise<void> }
const ORDER = ['fix', 'feature', 'agents', 'goal', 'channels', 'mods'] as const
type ScenarioName = (typeof ORDER)[number]

function pickScenario(text: string, turn: number): ScenarioName {
  const t = text.toLowerCase()
  if (t.startsWith('/goal') || t.includes('goal') || t.includes('目標')) return 'goal'
  if (/agent|team|parallel|subagent|代理|團隊|並行|平行/.test(t)) return 'agents'
  if (/feature|add|build|implement|新增|功能|實作/.test(t)) return 'feature'
  if (/channel|telegram|message|peer|頻道|訊息|消息/.test(t)) return 'channels'
  if (/mod|rm |clean|clear|刪|清/.test(t)) return 'mods'
  if (/fix|bug|修/.test(t)) return 'fix'
  return ORDER[(turn - 1) % ORDER.length]
}

const SCENARIOS: Record<ScenarioName, Scenario> = {
  // Read, edit with a diff, a command behind approval, a summary table.
  fix: {
    title: () => L('Fix the result count in retrieval.py', '修正 retrieval.py 的回傳筆數'),
    run: async socket => {
      const a: Api = socket.api
      const read = tool('Read', { file_path: `${WORK_DIR}/retrieval.py` })
      await a.wait(500)
      await a.say([{ type: 'text', text: L('Search returns too few results. Let me look at the current implementation.', '搜尋回傳的結果太少，先看一下目前的實作。') }, read])
      await a.wait(500)
      a.result(read.id, '1\tfrom index import Index\n2\t\n3\tTOP_K = 10\n4\t\n5\t\n6\tdef search(index: Index, query: str):\n7\t    return index.query(query)[:TOP_K]')
      const edit = editTool('retrieval.py', 'TOP_K = 10', 'TOP_K = 20', '@@\n-TOP_K = 10\n+TOP_K = 20')
      await a.wait(400)
      await a.say([{ type: 'text', text: L('`TOP_K` caps the results at 10 on line 3. Raising it to 20.', '第 3 行的 `TOP_K` 把結果限制在 10 筆，改成 20。') }, edit])
      await a.wait(500)
      a.result(edit.id, L('The file retrieval.py has been updated.', '已更新 retrieval.py。'), patch([' from index import Index', ' ', '-TOP_K = 10', '+TOP_K = 20', ' ', ' ']))
      const input = { command: 'sh run_tests.sh', description: 'Run the test suite' }
      const bash = tool('Bash', input)
      await a.wait(400)
      await a.say([{ type: 'text', text: L('Running the tests.', '跑一下測試。') }, bash])
      if (!(await a.ask(bash.id, 'Bash', input, 'sh run_tests.sh'))) {
        a.result(bash.id, L('The user denied this command.', '使用者拒絕了這個命令。'), {}, true)
        await a.wait(400)
        await a.say([{ type: 'text', text: L('OK, I left the tests alone. The edit to retrieval.py is in place.', '好，不跑測試了。retrieval.py 的修改已完成。') + NEXT() }])
        return
      }
      await a.wait(900)
      a.result(bash.id, '......\n6 passed in 0.41s')
      await a.wait(400)
      await a.say([
        {
          type: 'text',
          text:
            L('Done. All tests pass.\n\n| Item | Before | After |\n| --- | --- | --- |\n| `TOP_K` | 10 | 20 |\n| Tests | — | 6 passed |', '改好了，測試全部通過。\n\n| 項目 | 改動前 | 改動後 |\n| --- | --- | --- |\n| `TOP_K` | 10 | 20 |\n| 測試 | — | 6 passed |') +
            NEXT(),
        },
      ])
    },
  },

  // Thinking, a todo list, search, a new file and an edit, tests, a summary with code.
  feature: {
    title: () => L('Add a --json flag to the search CLI', '幫搜尋 CLI 加上 --json 參數'),
    run: async socket => {
      const a: Api = socket.api
      const todos = (s: string[]) =>
        tool('TodoWrite', {
          todos: [
            { content: L('Find where results are printed', '找出結果輸出的位置'), activeForm: L('Finding the printer', '尋找輸出位置'), status: s[0] },
            { content: L('Add a JSON formatter', '新增 JSON 格式化'), activeForm: L('Adding the formatter', '新增格式化'), status: s[1] },
            { content: L('Wire up --json and test it', '接上 --json 並測試'), activeForm: L('Wiring up --json', '接上 --json'), status: s[2] },
          ],
        })
      await a.wait(400)
      const t1 = todos(['in_progress', 'pending', 'pending'])
      await a.say([
        { type: 'thinking', thinking: L('The CLI prints results as text in cli.py. A --json flag needs a formatter that keeps score and path, plus a test. Plan it as three steps.', 'CLI 在 cli.py 用文字印結果。--json 需要一個保留分數和路徑的格式化函式，再加測試。分三步做。') },
        { type: 'text', text: L('Three steps. Tracking them in the todo list on the right.', '分三步做，進度放在右側的待辦清單。') },
        t1,
      ])
      a.result(t1.id, 'Todos have been modified successfully.')
      const grep = tool('Grep', { pattern: 'print\\(', path: WORK_DIR, output_mode: 'content' })
      await a.wait(300)
      await a.say([grep])
      await a.wait(500)
      a.result(grep.id, 'cli.py:18:        print(f"{hit.score:.2f}  {hit.path}")\nscripts/bench.py:9:    print(elapsed)')
      const write = tool('Write', { file_path: `${WORK_DIR}/format.py`, content: 'import json\n\n\ndef to_json(hits) -> str:\n    return json.dumps([{"path": h.path, "score": round(h.score, 4)} for h in hits], indent=2)\n' })
      const t2 = todos(['completed', 'in_progress', 'pending'])
      await a.wait(300)
      await a.say([{ type: 'text', text: L('Results are printed at cli.py:18. Adding the formatter as its own module.', '結果在 cli.py 第 18 行輸出。格式化放進獨立模組。') }, t2, write])
      a.result(t2.id, 'Todos have been modified successfully.')
      await a.wait(500)
      a.result(
        write.id,
        L('File created successfully at: format.py', '已建立 format.py'),
        patch(['+import json', '+', '+', '+def to_json(hits) -> str:', '+    return json.dumps([{"path": h.path, "score": round(h.score, 4)} for h in hits], indent=2)'], 0, 'create'),
      )
      const edit = editTool(
        'cli.py',
        '        print(f"{hit.score:.2f}  {hit.path}")',
        '    if args.json:\n        print(to_json(hits))\n        return\n    for hit in hits:\n        print(f"{hit.score:.2f}  {hit.path}")',
        '@@\n+    if args.json:\n+        print(to_json(hits))\n+        return',
      )
      const t3 = todos(['completed', 'completed', 'in_progress'])
      await a.wait(300)
      await a.say([t3, edit])
      a.result(t3.id, 'Todos have been modified successfully.')
      await a.wait(500)
      a.result(
        edit.id,
        L('The file cli.py has been updated.', '已更新 cli.py。'),
        patch(['     hits = search(index, args.query)', '+    if args.json:', '+        print(to_json(hits))', '+        return', '     for hit in hits:', '         print(f"{hit.score:.2f}  {hit.path}")'], 15),
      )
      const input = { command: 'python cli.py "vector index" --json | head -8', description: 'Try the new flag' }
      const bash = tool('Bash', input)
      await a.wait(300)
      await a.say([bash])
      if (!(await a.ask(bash.id, 'Bash', input, 'python cli.py:*'))) {
        a.result(bash.id, L('The user denied this command.', '使用者拒絕了這個命令。'), {}, true)
        await a.wait(300)
        await a.say([{ type: 'text', text: L('Skipped the run. The flag is wired up in cli.py and format.py.', '沒有執行。--json 已經接在 cli.py 和 format.py。') + NEXT() }])
        return
      }
      await a.wait(800)
      a.result(bash.id, '[\n  {\n    "path": "docs/index.md",\n    "score": 0.9132\n  },\n  {\n    "path": "src/vector.py",')
      const t4 = todos(['completed', 'completed', 'completed'])
      await a.wait(300)
      await a.say([
        t4,
        {
          type: 'text',
          text:
            L('`--json` works. Usage:', '`--json` 可以用了，用法：') +
            '\n\n```sh\npython cli.py "vector index" --json\n```\n\n' +
            L('- `format.py`: new `to_json()`\n- `cli.py`: prints JSON and returns when `--json` is set', '- `format.py`：新增 `to_json()`\n- `cli.py`：有 `--json` 時輸出 JSON 後返回') +
            NEXT(),
        },
      ])
      a.result(t4.id, 'Todos have been modified successfully.')
    },
  },

  // Three subagents in parallel; the Agents tab follows their progress.
  agents: {
    title: () => L('Review the repo with three agents', '用三個 agent 審查專案'),
    run: async socket => {
      const a: Api = socket.api
      const jobs = [
        { type: 'Explore', desc: L('Map the indexing code', '整理索引相關程式'), tools: ['Glob', 'Read', 'Grep'], out: L('Indexing lives in index.py and vector.py; rebuilds are full, no incremental path.', '索引在 index.py 與 vector.py；每次都全量重建，沒有增量。') },
        { type: 'general-purpose', desc: L('Find slow tests', '找出慢的測試'), tools: ['Bash', 'Read'], out: L('test_rebuild takes 4.1s of the 5.0s suite; it rebuilds the whole fixture index.', 'test_rebuild 佔整個 5.0 秒中的 4.1 秒，它重建了整個測試索引。') },
        { type: 'Explore', desc: L('Check docs against the CLI', '核對文件和 CLI'), tools: ['Read', 'Grep'], out: L('README still documents --limit, which the CLI renamed to --top-k.', 'README 還寫著 --limit，CLI 已改名為 --top-k。') },
      ].map(j => ({ ...j, call: tool('Agent', { subagent_type: j.type, description: j.desc, prompt: j.desc }), task: uid('task') }))
      await a.wait(400)
      await a.say([{ type: 'text', text: L('Splitting this into three independent reviews and running them in parallel. Open the **Agents** tab on the right to watch them.', '拆成三個互不相關的審查並行跑。打開右側的 **Agents** 分頁可以看到它們的進度。') }, ...jobs.map(j => j.call)])
      for (const j of jobs) a.system('task_started', { task_id: j.task, task_type: 'local_agent', description: j.desc, subagent_type: j.type, tool_use_id: j.call.id })
      for (let step = 0; step < 3; step++) {
        await a.wait(1100)
        for (const [i, j] of jobs.entries()) {
          a.system('task_progress', { task_id: j.task, tool_use_id: j.call.id, last_tool_name: j.tools[(step + i) % j.tools.length], usage: { total_tokens: 4200 * (step + 1) + i * 900, tool_uses: 2 * (step + 1) + i, duration_ms: 1100 * (step + 1) } })
        }
      }
      for (const [i, j] of jobs.entries()) {
        await a.wait(600)
        a.system('task_notification', { task_id: j.task, tool_use_id: j.call.id, status: 'completed', summary: j.out, usage: { total_tokens: 15400 + i * 2100, tool_uses: 8 + i, duration_ms: 4200 + i * 600 } })
        a.result(j.call.id, j.out)
      }
      await a.wait(400)
      await a.say([
        {
          type: 'text',
          text:
            L(
              'All three are back.\n\n| Agent | Finding |\n| --- | --- |\n',
              '三個都回來了。\n\n| Agent | 發現 |\n| --- | --- |\n',
            ) +
            jobs.map(j => `| ${j.desc} | ${j.out} |`).join('\n') +
            L('\n\nThe biggest win is an incremental index rebuild; it would also fix the slow test.', '\n\n最值得做的是增量重建索引，順便能解決慢測試。') +
            NEXT(),
        },
      ])
    },
  },

  // /goal: a finish condition checked after every round until it holds.
  goal: {
    title: () => L('/goal all tests pass', '/goal 所有測試通過'),
    run: async socket => {
      const a: Api = socket.api
      const condition = L('all tests pass', '所有測試通過')
      const setAt = Date.now()
      a.system('goal_state_changed', { goal: { condition, status: 'active', iterations: 0, setAt } })
      const run1 = tool('Bash', { command: 'bun test', description: 'Run the tests' })
      await a.wait(400)
      await a.say([{ type: 'text', text: L(`Goal set: **${condition}**. Checking where we stand.`, `目標已設定：**${condition}**。先看看目前狀況。`) }, run1])
      await a.wait(900)
      a.result(run1.id, 'tokenize.test.ts:\n✓ splits on whitespace\n✗ keeps CJK runs together\n  expected ["向量","索引"] got ["向","量","索","引"]\n\n12 pass\n2 fail', {}, true)
      await a.wait(500)
      a.system('goal_state_changed', { goal: { condition, status: 'active', iterations: 1, setAt, met: false, reason: L('2 tests still fail in tokenize.test.ts', 'tokenize.test.ts 還有 2 個測試失敗') } })
      a.system('api_retry', { attempt: 1, max_retries: 10, retry_delay_ms: 1500, error_status: 529 })
      await a.wait(1800)
      const read = tool('Read', { file_path: `${WORK_DIR}/tokenize.ts` })
      await a.say([{ type: 'text', text: L('Not met yet: CJK text is split per character. Looking at the tokenizer.', '還沒達成：中日韓文字被逐字切開。看一下分詞器。') }, read])
      await a.wait(400)
      a.result(read.id, '1\texport function tokenize(s: string): string[] {\n2\t  return s.split(/\\s+|(?=[\\u4e00-\\u9fff])/u).filter(Boolean)\n3\t}')
      const edit = editTool(
        'tokenize.ts',
        "  return s.split(/\\s+|(?=[\\u4e00-\\u9fff])/u).filter(Boolean)",
        "  return s.match(/[\\u4e00-\\u9fff]+|[^\\s\\u4e00-\\u9fff]+/gu) ?? []",
        "@@\n-  return s.split(/\\s+|(?=[\\u4e00-\\u9fff])/u).filter(Boolean)\n+  return s.match(/[\\u4e00-\\u9fff]+|[^\\s\\u4e00-\\u9fff]+/gu) ?? []",
      )
      await a.wait(300)
      await a.say([{ type: 'text', text: L('The lookahead splits before every CJK character. Matching runs instead.', '正規表達式在每個中文字前都切一刀，改成整段比對。') }, edit])
      await a.wait(500)
      a.result(
        edit.id,
        L('The file tokenize.ts has been updated.', '已更新 tokenize.ts。'),
        patch([' export function tokenize(s: string): string[] {', "-  return s.split(/\\s+|(?=[\\u4e00-\\u9fff])/u).filter(Boolean)", "+  return s.match(/[\\u4e00-\\u9fff]+|[^\\s\\u4e00-\\u9fff]+/gu) ?? []", ' }']),
      )
      const run2 = tool('Bash', { command: 'bun test', description: 'Run the tests' })
      await a.wait(300)
      await a.say([run2])
      await a.wait(900)
      a.result(run2.id, '14 pass\n0 fail\nRan 14 tests across 3 files. [0.38s]')
      await a.wait(400)
      await a.say([{ type: 'text', text: L('All 14 tests pass.', '14 個測試全部通過。') + NEXT() }])
      a.system('goal_state_changed', { goal: { condition, status: 'met', iterations: 2, durationMs: Date.now() - setAt } })
    },
  },

  // A Telegram message comes in, Claude asks another session and answers on Telegram.
  channels: {
    title: () => L('Answer a Telegram question with help from docs-writer', '在 Telegram 回答問題，並請 docs-writer 協助'),
    run: async socket => {
      const a: Api = socket.api
      await a.wait(500)
      a.inbound(`<channel source="plugin:telegram:telegram" user="alice" chat_id="1001">${L('Is the --top-k flag documented anywhere?', '--top-k 參數有寫在文件裡嗎？')}</channel>`)
      const send = tool('SendMessage', { to: 'docs-writer', message: L('Does the README cover --top-k? Alice is asking on Telegram.', 'README 有寫到 --top-k 嗎？Alice 在 Telegram 問。') })
      await a.wait(600)
      await a.say([{ type: 'text', text: L('A question came in on the **Telegram** channel. The docs-writer session owns the README, so I am asking it directly.', '**Telegram** 頻道來了一個問題。README 由 docs-writer 這個會話負責，直接問它。') }, send])
      await a.wait(400)
      a.result(send.id, L('Message sent to docs-writer.', '已傳給 docs-writer。'))
      await a.wait(1600)
      a.inbound(`<cross-session-message from-name="docs-writer">${L('Not yet: README still says --limit. I just added a --top-k section and pushed it to docs/cli.md.', '還沒有：README 還寫著 --limit。我剛補了 --top-k 一節，放在 docs/cli.md。')}</cross-session-message>`)
      const reply = tool('mcp__plugin_telegram_telegram__reply', { chat_id: '1001', text: L('It is now: docs/cli.md has a --top-k section (it replaced --limit).', '現在有了：docs/cli.md 新增了 --top-k 一節（取代原本的 --limit）。') })
      await a.wait(500)
      await a.say([reply])
      await a.wait(400)
      a.result(reply.id, 'sent (message_id 5521)')
      await a.wait(300)
      await a.say([
        {
          type: 'text',
          text:
            L(
              'Answered Alice on Telegram. Channels push outside messages into a session; SendMessage and the other session reply between Claude sessions running on this machine.',
              '已在 Telegram 回覆 Alice。頻道會把外部訊息推進會話；SendMessage 則讓本機上的 Claude 會話互相傳訊。',
            ) + NEXT(),
        },
      ])
    },
  },

  // Two mods at work: blast-radius guards rm -r, token-meter writes the status line.
  mods: {
    title: () => L('Clear the build directory', '清掉 build 目錄'),
    run: async socket => {
      const a: Api = socket.api
      const input = { command: 'rm -rf build', description: 'Remove build output' }
      const bash = tool('Bash', input)
      await a.wait(400)
      await a.say([{ type: 'text', text: L('Removing the build output.', '刪除建置輸出。') }, bash])
      await a.wait(300)
      a.toast('blast-radius', L('rm -r would delete 3 files under build/: a.js, b.js, c.js', 'rm -r 會刪除 build/ 底下 3 個檔案：a.js、b.js、c.js'))
      a.system('hook_response', { hook_event: 'PreToolUse', hook_name: 'PreToolUse:Bash', outcome: 'success', stdout: JSON.stringify({ systemMessage: L('blast-radius: 3 files under build/', 'blast-radius：build/ 底下 3 個檔案') }) })
      if (!(await a.ask(bash.id, 'Bash', input, 'rm -rf build'))) {
        a.result(bash.id, L('The user denied this command.', '使用者拒絕了這個命令。'), {}, true)
        await a.wait(300)
        await a.say([{ type: 'text', text: L('Left build/ alone.', 'build/ 沒有動。') + NEXT() }])
        return
      }
      await a.wait(500)
      a.result(bash.id, '')
      a.status('token-meter', L('ctx 31k / 1M · $0.21 this session', '上下文 31k / 1M · 本會話 $0.21'))
      await a.wait(300)
      await a.say([
        {
          type: 'text',
          text:
            L(
              'build/ is gone. Two mods took part: **blast-radius** showed what `rm -r` would delete before you approved it, and **token-meter** keeps context and cost in the status line. Open **Mods** in the sidebar to switch them or edit their source.',
              'build/ 已刪除。這一輪有兩個 mod 參與：**blast-radius** 在你批准前列出 `rm -r` 會刪掉什麼，**token-meter** 把上下文與花費放在狀態列。打開側欄的 **Mods** 可以開關它們或修改原始碼。',
            ) + NEXT(),
        },
      ])
    },
  },
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && (c as Json).type === 'text' ? String((c as Json).text) : '')).join('')
  return ''
}

;(window as unknown as { WebSocket: unknown }).WebSocket = DemoSocket

export {}
