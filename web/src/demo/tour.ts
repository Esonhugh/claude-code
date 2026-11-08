// A guided tour for the website demo: highlights parts of the real UI one at a time and says what each does.
// The start-page steps run on first visit; the session steps run the first time a session view opens.
// The "Guide" button in the corner replays whichever set fits the current view.

type Step = { find: () => Element | null | undefined; en: [string, string]; zh: [string, string] }

const zh = (navigator.language || '').toLowerCase().startsWith('zh')
const $ = (sel: string) => document.querySelector(sel)
const byText = (sel: string, re: RegExp) => [...document.querySelectorAll(sel)].find(el => re.test(el.textContent ?? ''))

const START: Step[] = [
  {
    find: () => $('textarea'),
    en: ['Ask anything', 'This is the real claude web UI with a scripted backend. Type any message and press Enter: each one plays a scenario (bug fix, new feature, parallel agents, /goal, channels, mods).'],
    zh: ['隨便問', '這是真正的 claude web 介面，後端換成腳本。輸入任何訊息按 Enter，每次會播一個情境：修 bug、新功能、並行 agent、/goal、頻道、mods。'],
  },
  {
    find: () => byText('main button', /mode/),
    en: ['Permission mode', 'Manual asks before edits and commands; auto mode and plan mode are one click away. The same modes as the terminal.'],
    zh: ['權限模式', 'manual 會在改檔與執行命令前詢問；auto 與 plan 模式一鍵切換，和終端裡相同。'],
  },
  {
    find: () => byText('main button', /Opus|GPT|Sonnet/),
    en: ['Model and effort', 'Pick the model, effort and context window. On a ChatGPT account the list comes from that account’s Codex catalog.'],
    zh: ['模型與推理強度', '選模型、effort 和上下文視窗。用 ChatGPT 帳號時，清單來自該帳號的 Codex 目錄。'],
  },
  {
    find: () => $('nav.snav'),
    en: ['Extensions', 'MCP servers, skills, plugins, memory and hooks, each with its own manager. Mods and channels live under Plugins.'],
    zh: ['擴充', 'MCP、skills、外掛、記憶、hooks 各有管理頁。Mods 與頻道在外掛裡。'],
  },
  {
    find: () => byText('aside.sidebar *', /^▾?\s*(Recent folders|最近目錄)/)?.parentElement,
    en: ['Sessions by folder', 'Past sessions grouped by project folder, searchable. Open one to read its transcript or continue it.'],
    zh: ['按目錄分組的會話', '過去的會話依專案目錄分組，可搜尋；點開可以看紀錄或接著做。'],
  },
  {
    find: () => $('button.acct'),
    en: ['Claude or ChatGPT', 'Switch accounts here: Account → Authentication. Tools, UI and slash commands stay the same on both.'],
    zh: ['Claude 或 ChatGPT', '在這裡切換帳號（Account → Authentication）。兩種帳號的工具、介面與斜線指令都一樣。'],
  },
]

const SESSION: Step[] = [
  {
    find: () => $('main .chip, main [class*=chip]'),
    en: ['Session status', 'Running or ready, the folder, and how much of the context window is used. Click the context chip for the breakdown.'],
    zh: ['會話狀態', '執行中或待命、工作目錄、上下文用量。點上下文可以看細項。'],
  },
  {
    find: () => $('aside.side .tabs'),
    en: ['Side panel', 'Status shows cost and limits; Files lists every file this session touched; Agents follows subagents and teammates; Mods appears when a mod draws here.'],
    zh: ['側邊面板', 'Status 看花費與額度；Files 列出這個會話動過的檔案；Agents 追蹤子 agent 與隊友；有 mod 時會多出 Mods 分頁。'],
  },
  {
    find: () => $('.cbox') ?? $('textarea'),
    en: ['Keep going', 'Approvals appear right above this box. Try “agents”, “/goal”, “channels” or “mods” to jump to a scenario.'],
    zh: ['繼續', '需要批准時會出現在輸入框上方。輸入「agents」「/goal」「channels」「mods」可以直接跳到該情境。'],
  },
]

const css = `
.demo-tour-ring{position:fixed;z-index:9998;border-radius:10px;box-shadow:0 0 0 2px #d97757,0 0 0 9999px rgba(20,20,19,.5);pointer-events:none;transition:all .2s ease}
.demo-tour-card{position:fixed;z-index:9999;width:min(320px,calc(100vw - 32px));background:#fff;color:#1f1e1d;border-radius:12px;padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.25);font:14px/1.55 system-ui,sans-serif}
.demo-tour-card h3{margin:0 0 4px;font-size:15px}
.demo-tour-card p{margin:0 0 12px;color:#5e5d59}
.demo-tour-card .row{display:flex;align-items:center;gap:8px}
.demo-tour-card .n{color:#8a8985;font-size:12px;margin-right:auto}
.demo-tour-card button,.demo-tour-btn{font:inherit;font-size:13px;border-radius:8px;border:1px solid #d6d4cc;background:#fff;color:#1f1e1d;padding:5px 12px;cursor:pointer}
.demo-tour-card button.primary{background:#d97757;border-color:#d97757;color:#fff}
.demo-tour-btn{position:fixed;right:16px;bottom:16px;z-index:9997;box-shadow:0 4px 16px rgba(0,0,0,.15)}
@media (max-width:700px){.demo-tour-btn{bottom:132px;right:8px;padding:4px 10px;opacity:.92}}
@media (prefers-color-scheme:dark){.demo-tour-card{background:#262624;color:#f0eee6}.demo-tour-card p{color:#b7b5a9}.demo-tour-card button,.demo-tour-btn{background:#30302e;color:#f0eee6;border-color:#4a4945}}
`

const seen = (key: string) => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
const remember = (key: string) => {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // Private windows: the tour just shows again next time.
  }
}

let stop: (() => void) | undefined

function run(steps: Step[]) {
  stop?.()
  const visible = (el: Element | null | undefined) => {
    const r = el?.getBoundingClientRect()
    return !!r && r.width > 0 && r.left >= 0 && r.right <= innerWidth
  }
  // On a phone the sidebar is closed, so its steps drop out.
  const live = steps.filter(s => visible(s.find()))
  if (!live.length) return
  const ring = document.createElement('div')
  ring.className = 'demo-tour-ring'
  const card = document.createElement('div')
  card.className = 'demo-tour-card'
  card.setAttribute('role', 'dialog')
  document.body.append(ring, card)
  let i = 0
  const place = () => {
    const target = live[i]!.find()
    if (!target) return
    const r = target.getBoundingClientRect()
    const pad = 6
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` })
    const cw = card.offsetWidth
    const ch = card.offsetHeight
    const below = r.bottom + 14 + ch < innerHeight
    const top = below ? r.bottom + 14 : Math.max(12, r.top - 14 - ch)
    const left = Math.min(Math.max(12, r.left), innerWidth - cw - 12)
    Object.assign(card.style, { left: `${left}px`, top: `${Math.min(top, innerHeight - ch - 12)}px` })
  }
  const show = () => {
    const [title, body] = zh ? live[i]!.zh : live[i]!.en
    card.replaceChildren()
    const h = document.createElement('h3')
    h.textContent = title
    const p = document.createElement('p')
    p.textContent = body
    const row = document.createElement('div')
    row.className = 'row'
    const n = document.createElement('span')
    n.className = 'n'
    n.textContent = `${i + 1} / ${live.length}`
    const skip = document.createElement('button')
    skip.textContent = zh ? '略過' : 'Skip'
    skip.onclick = () => stop?.()
    const next = document.createElement('button')
    next.className = 'primary'
    next.textContent = i === live.length - 1 ? (zh ? '開始' : 'Done') : zh ? '下一步' : 'Next'
    next.onclick = () => (i === live.length - 1 ? stop?.() : (i++, show()))
    row.append(n, skip)
    if (i > 0) {
      const back = document.createElement('button')
      back.textContent = zh ? '上一步' : 'Back'
      back.onclick = () => (i--, show())
      row.append(back)
    }
    row.append(next)
    card.append(h, p, row)
    place()
    next.focus()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop?.()
  }
  addEventListener('resize', place)
  addEventListener('keydown', onKey)
  stop = () => {
    ring.remove()
    card.remove()
    removeEventListener('resize', place)
    removeEventListener('keydown', onKey)
    stop = undefined
  }
  show()
}

function start() {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const btn = document.createElement('button')
  btn.className = 'demo-tour-btn'
  btn.textContent = zh ? '導覽' : 'Guide'
  btn.onclick = () => run($('aside.side') ? SESSION : START)
  document.body.append(btn)
  // Wait for the app to render before the first-visit tour.
  const poll = setInterval(() => {
    if (!stop && $('aside.side') && !seen('demo-tour-session')) {
      remember('demo-tour-session')
      setTimeout(() => run(SESSION), 6000)
    }
    if (!stop && $('textarea') && !$('aside.side') && !seen('demo-tour-start')) {
      remember('demo-tour-start')
      run(START)
    }
    if (seen('demo-tour-start') && seen('demo-tour-session')) clearInterval(poll)
  }, 500)
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start)
else start()

export {}
