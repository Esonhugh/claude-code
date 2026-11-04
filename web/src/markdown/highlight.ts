import type { HighlighterCore } from 'shiki/core'

// Only common languages are bundled; each loads on first use.
const LANGS: Record<string, () => Promise<unknown>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  zsh: 'bash',
  console: 'bash',
  'c++': 'cpp',
  cs: 'csharp',
  dockerfile: 'docker',
  golang: 'go',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  kt: 'kotlin',
  tex: 'latex',
  sty: 'latex',
  cls: 'latex',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  ts: 'typescript',
  mts: 'typescript',
  yml: 'yaml',
  svg: 'xml',
  patch: 'diff',
}

export function resolveLang(lang: string | null | undefined): string | undefined {
  if (!lang) return undefined
  const id = lang.toLowerCase()
  const resolved = ALIASES[id] ?? id
  return resolved in LANGS ? resolved : undefined
}

let highlighter: Promise<HighlighterCore> | undefined
const loaded = new Map<string, Promise<void>>()

async function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
      await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ])
    return createHighlighterCore({
      themes: [
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs'),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return highlighter
}

// Switching back to a session redraws its code blocks; highlighted ones come from here at once.
const CACHE_SIZE = 500
const cache = new Map<string, string>()

/** The HTML `highlight` already made for this code, if any. */
export function cachedHighlight(code: string, lang: string | null | undefined): string | undefined {
  const id = resolveLang(lang)
  return id ? cache.get(`${id}\n${code}`) : undefined
}

/** Highlighted HTML (shiki escapes the code), or undefined for unknown languages. */
export async function highlight(
  code: string,
  lang: string | null | undefined,
): Promise<string | undefined> {
  const id = resolveLang(lang)
  if (!id) return undefined
  const key = `${id}\n${code}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const hl = await getHighlighter()
  if (!loaded.has(id)) {
    loaded.set(
      id,
      LANGS[id]!().then(mod =>
        hl.loadLanguage((mod as { default: Parameters<HighlighterCore['loadLanguage']>[0] }).default),
      ),
    )
  }
  await loaded.get(id)
  const html = hl.codeToHtml(code, {
    lang: id,
    themes: { light: 'github-light', dark: 'github-dark' },
  })
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!)
  cache.set(key, html)
  return html
}
