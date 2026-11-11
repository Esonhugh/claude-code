// Builds the GitHub Pages site into site/dist:
//   index.html          landing page (src/home.html)
//   docs/*.html         docs/features rendered with a sidebar; README.md becomes docs/index.html
//   benchmark/          test method and results (src/benchmark.html) + the interactive scatter
//   assets/             shared CSS/JS and the demo animation bundle
// `bun build.ts --serve` also serves dist on http://localhost:4173.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { Marked, type Tokens } from 'marked'

const SITE = import.meta.dir
const REPO = join(SITE, '..')
const FEATURES = join(REPO, 'docs/features')
const OUT = join(SITE, 'dist')
const BLOB = 'https://github.com/Esonhugh/claude-code/blob/dev'
const TREE = 'https://github.com/Esonhugh/claude-code/tree/dev'

const read = (p: string) => readFileSync(p, 'utf8')
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'assets'), { recursive: true })
mkdirSync(join(OUT, 'docs'), { recursive: true })
mkdirSync(join(OUT, 'benchmark'), { recursive: true })

// ---------- shared shell ----------

const bootLang = `<script>(function(){var l;try{l=localStorage.getItem('lang')}catch(e){}if(!l){var n=(navigator.language||'').toLowerCase();l=n.indexOf('zh')!==0?'en':/hant|tw|hk|mo/.test(n)?'zh':'hans'}document.documentElement.setAttribute('data-lang',l);document.documentElement.lang=l==='zh'?'zh-Hant':l==='hans'?'zh-Hans':'en';var t;try{t=localStorage.getItem('theme')}catch(e){}if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)})()</script>`

function page(opts: { base: string; title: string; description: string; main: string; scripts?: string[] }): string {
  const { base } = opts
  const scripts = ['assets/site.js', ...(opts.scripts ?? [])].map(s => `<script src="${base}${s}" defer></script>`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Sans+TC:wght@400;500;700&family=Noto+Sans+SC:wght@400;500;700&display=swap">
<link rel="stylesheet" href="${base}assets/style.css">
${bootLang}
</head>
<body>
<div class="banner"><div class="wrap">
  <span class="en">v2.1.297 is out on npm. New on dev: the Tmux tool, context-window tiers, a built-in agent benchmark.</span>
  <span class="hant">v2.1.297 已發佈到 npm。dev 上新增：Tmux 工具、上下文窗口檔位、內建 agent 基準測試。</span>
  <span class="hans">v2.1.297 已发布到 npm。dev 上新增：Tmux 工具、上下文窗口档位、内置 agent 基准测试。</span>
  <a href="${BLOB}/CHANGELOG.md">CHANGELOG</a>
</div></div>
<header class="top"><div class="wrap">
  <a class="brand" href="${base}"><span class="dot" aria-hidden="true"></span>esonhugh/claude-code</a>
  <nav class="links" aria-label="Main">
    <a href="${base}docs/"><span class="en">Docs</span><span class="hant">文件</span><span class="hans">文档</span></a>
    <a href="${base}benchmark/"><span class="en">Benchmark</span><span class="hant">基準測試</span><span class="hans">基准测试</span></a>
    <a href="${base}web-demo/"><span class="en">Live demo</span><span class="hant">試玩</span><span class="hans">试玩</span></a>
    <a href="${BLOB}/CHANGELOG.md"><span class="en">Changelog</span><span class="hant">變更紀錄</span><span class="hans">更新日志</span></a>
    <a href="https://github.com/Esonhugh/claude-code">GitHub</a>
    <a href="https://www.npmjs.com/package/@esonhugh/claude-code">npm</a>
  </nav>
  <div class="toggles">
    <div class="seg" role="group" aria-label="Language"><button type="button" data-lang="hans" lang="zh-Hans">简</button><button type="button" data-lang="zh" lang="zh-Hant">繁</button><button type="button" data-lang="en">EN</button></div>
    <div class="seg" role="group" aria-label="Theme"><button type="button" data-th="auto">Auto</button><button type="button" data-th="light">Light</button><button type="button" data-th="dark">Dark</button></div>
  </div>
</div></header>
${opts.main}
<footer><div class="wrap">
  <nav aria-label="Footer"><a href="https://github.com/Esonhugh/claude-code">GitHub</a><a href="https://www.npmjs.com/package/@esonhugh/claude-code">npm</a><a href="${BLOB}/CHANGELOG.md">Changelog</a><a href="${base}docs/">Docs</a><a href="${base}benchmark/">Benchmark</a></nav>
  <div class="en">Maintained by Esonhugh. Not an Anthropic product and not endorsed by Anthropic. The npm package ships a launcher and per-platform binaries only.</div>
  <div class="hant">由 Esonhugh 維護。本專案不是 Anthropic 產品，也未獲 Anthropic 背書。npm 套件只包含 launcher 與各平台二進位檔。</div>
  <div class="hans">由 Esonhugh 维护。本项目不是 Anthropic 产品，也未获 Anthropic 背书。npm 包只包含 launcher 与各平台二进制文件。</div>
</div></footer>
${scripts}
</body>
</html>
`
}

// ---------- docs ----------

const docFiles = readdirSync(FEATURES).filter(f => f.endsWith('.md')).sort()
const htmlName = (md: string) => (md === 'README.md' ? 'index.html' : md.replace(/\.md$/, '.html'))
const titleOf = (md: string) => read(join(FEATURES, md)).match(/^# (.+)$/m)?.[1]?.trim() ?? md

// Sidebar groups follow the domain column of the feature table in docs/features/README.md.
const groups: { name: string; items: { file: string; title: string }[] }[] = []
const seen = new Set<string>()
for (const line of read(join(FEATURES, 'README.md')).split('\n')) {
  const m = line.match(/^\|\s*([^|]*?)\s*\|\s*\[([^\]]+)\]\(([\w.-]+\.md)(?:#[^)]*)?\)/)
  if (!m) continue
  const [, domain, , file] = m
  if (seen.has(file!) || !docFiles.includes(file!)) continue
  seen.add(file!)
  if (domain) groups.push({ name: domain, items: [] })
  groups.at(-1)?.items.push({ file: file!, title: titleOf(file!) })
}
const orphans = docFiles.filter(f => f !== 'README.md' && !seen.has(f))
if (orphans.length) groups.push({ name: '其他', items: orphans.map(file => ({ file, title: titleOf(file) })) })

// GitHub-style heading slugs so existing `file.md#anchor` links keep working.
function slugger() {
  const used = new Map<string, number>()
  return (text: string) => {
    const base = text.toLowerCase().trim().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    return n ? `${base}-${n}` : base
  }
}

function rewriteHref(href: string): string {
  if (/^([a-z][a-z0-9+.-]*:|#)/i.test(href)) return href
  const [file = '', anchor] = href.split('#')
  const suffix = anchor === undefined ? '' : `#${anchor}`
  if (!file.includes('/') && docFiles.includes(file)) return htmlName(file) + suffix
  if (file.startsWith('images/')) return file + suffix
  const repoPath = posix.normalize(posix.join('docs/features', file))
  if (repoPath.startsWith('../')) return href
  return `${file.endsWith('/') ? TREE : BLOB}/${repoPath}${suffix}`
}

function renderDoc(md: string): string {
  const slug = slugger()
  const marked = new Marked({ gfm: true })
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens)
        if (depth === 1) return `<h1>${inner}</h1>\n`
        const id = slug(inner)
        return `<h${depth} id="${esc(id)}"><a class="anchor" href="#${esc(id)}">${inner}</a></h${depth}>\n`
      },
      link({ href, title, tokens }: Tokens.Link) {
        const t = title ? ` title="${esc(title)}"` : ''
        return `<a href="${esc(rewriteHref(href))}"${t}>${this.parser.parseInline(tokens)}</a>`
      },
      image({ href, title, text }: Tokens.Image) {
        // `#gh-light-mode-only` / `#gh-dark-mode-only` pairs follow the site theme instead.
        const cls = href.endsWith('#gh-light-mode-only') ? ' class="light-only"' : href.endsWith('#gh-dark-mode-only') ? ' class="dark-only"' : ''
        const src = rewriteHref(href.replace(/#gh-(light|dark)-mode-only$/, ''))
        const t = title ? ` title="${esc(title)}"` : ''
        return `<img src="${esc(src)}" alt="${esc(text)}"${t}${cls} loading="lazy">`
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell) => this.parser.parseInline(c.tokens)
        const head = `<tr>${token.header.map(c => `<th>${cell(c)}</th>`).join('')}</tr>`
        const body = token.rows.map(r => `<tr>${r.map(c => `<td>${cell(c)}</td>`).join('')}</tr>`).join('\n')
        return `<div class="tablewrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>\n`
      },
    },
  })
  return marked.parse(md, { async: false }) as string
}

function sidebar(current: string): string {
  const link = (file: string, title: string) =>
    `<a href="${htmlName(file)}"${file === current ? ' aria-current="page"' : ''}>${esc(title)}</a>`
  const body = groups.map(g => `<h4>${esc(g.name)}</h4>\n${g.items.map(i => link(i.file, i.title)).join('\n')}`).join('\n')
  return `<aside><details class="doc-nav"><summary><span class="en">All docs</span><span class="hant">全部文件</span><span class="hans">全部文档</span></summary>
${link('README.md', '功能索引')}
${body}
</details></aside>`
}

for (const file of docFiles) {
  const md = read(join(FEATURES, file))
  const title = titleOf(file)
  const main = `<main class="wrap docs">
${sidebar(file)}
<article class="prose">
<p class="doc-note en">The feature docs are written in Chinese. They are the same pages as the GitHub Wiki.</p>
${renderDoc(md)}
<p class="doc-foot"><span class="en">Source:</span><span class="hant">原始檔：</span><span class="hans">源文件：</span> <a href="${BLOB}/docs/features/${file}">docs/features/${file}</a></p>
</article>
</main>`
  writeFileSync(
    join(OUT, 'docs', htmlName(file)),
    page({ base: '../', title: `${title} · esonhugh/claude-code`, description: `${title}: feature documentation for the Esonhugh/claude-code fork.`, main }),
  )
}
cpSync(join(FEATURES, 'images'), join(OUT, 'docs/images'), { recursive: true })

// ---------- landing + benchmark ----------

const featureCount = docFiles.length - 1
writeFileSync(
  join(OUT, 'index.html'),
  page({
    base: '',
    title: 'esonhugh/claude-code · one CLI, Claude or ChatGPT',
    description: 'An unofficial Claude Code fork that runs on a Claude or ChatGPT account, with a browser UI, Mods and Agent Teams.',
    main: read(join(SITE, 'src/home.html')).replaceAll('{{featureCount}}', String(featureCount)),
    scripts: ['assets/demos.js'],
  }),
)
writeFileSync(
  join(OUT, 'benchmark/index.html'),
  page({
    base: '../',
    title: 'How we test · esonhugh/claude-code',
    description: 'Benchmark method and results: cache hit rate, tokens and cost per task across seven coding agents on Claude and ChatGPT accounts.',
    main:
      read(join(SITE, 'src/benchmark.html')) +
      `\n<script>window.BENCH = ${JSON.stringify(JSON.parse(read(join(SITE, 'src/benchmark/charts-data.json')))).replaceAll('</', '<\\/')}</script>`,
    scripts: ['assets/charts.js'],
  }),
)
const scatterData = JSON.stringify(JSON.parse(read(join(SITE, 'src/benchmark/scatter-data.json'))))
writeFileSync(
  join(OUT, 'benchmark/scatter.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${bootLang}
${read(join(SITE, 'src/benchmark/scatter-head.html'))}
<style>.back{display:block;max-width:980px;margin:16px auto 0;padding-left:max(16px,env(safe-area-inset-left,0px));font-size:13px;color:var(--ink2)}</style>
</head>
<body>
<a class="back" href="./"><span class="en">← How we test</span><span class="hant">← 我們怎麼測</span><span class="hans">← 我们怎么测</span></a>
${read(join(SITE, 'src/benchmark/scatter-body.html')).replace('__DATA__', () => scatterData.replaceAll('</', '<\\/'))}
</body>
</html>
`,
)

// ---------- assets ----------

cpSync(join(SITE, 'src/style.css'), join(OUT, 'assets/style.css'))
cpSync(join(SITE, 'src/site.js'), join(OUT, 'assets/site.js'))
cpSync(join(SITE, 'src/benchmark/charts.js'), join(OUT, 'assets/charts.js'))
const built = await Bun.build({
  entrypoints: [join(SITE, 'src/demos/main.tsx')],
  outdir: join(OUT, 'assets'),
  naming: 'demos.js',
  target: 'browser',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
if (!built.success) {
  for (const log of built.logs) console.error(log)
  process.exit(1)
}
// The live web demo: the real web/ app with web/src/demo/mock.ts standing in for the server.
const vite = Bun.spawnSync(['bun', 'x', 'vite', 'build', '-c', 'web/vite.demo.config.ts', '--logLevel', 'warn'], {
  cwd: REPO,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (vite.exitCode !== 0) process.exit(vite.exitCode ?? 1)
renameSync(join(OUT, 'web-demo/demo.html'), join(OUT, 'web-demo/index.html'))
writeFileSync(join(OUT, '.nojekyll'), '')

const count = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1), 0)
console.log(`Built ${docFiles.length} doc pages, landing, benchmark and demos into ${OUT} (${count(OUT)} files).`)

if (process.argv.includes('--serve')) {
  const server = Bun.serve({
    port: 4173,
    fetch(req) {
      let path = decodeURIComponent(new URL(req.url).pathname)
      if (path.endsWith('/')) path += 'index.html'
      const file = join(OUT, posix.normalize(path))
      if (!file.startsWith(OUT) || !existsSync(file)) return new Response('Not found', { status: 404 })
      return new Response(Bun.file(file))
    },
  })
  console.log(`Serving ${OUT} at http://localhost:${server.port}/`)
}
