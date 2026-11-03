import { type ReactNode, useEffect, useState } from 'react'
import { ext, type MemoryFile, type MemoryList } from '../extApi'
import { errorText, type ExtProps, Switch } from './extShared'

const TITLES: Partial<Record<MemoryFile['kind'], string>> = {
  user: '用户指令',
  project: '项目指令',
  local: '本地指令',
}

/** Lowercase whitespace-separated words of a query. */
export function queryWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean)
}

/** [start, end) of each case-insensitive occurrence of any word of `q`, left to right, longest first. */
export function matchRanges(text: string, q: string): [number, number][] {
  const words = queryWords(q)
  const lower = text.toLowerCase()
  const out: [number, number][] = []
  for (let at = 0; ; ) {
    let i = -1
    let len = 0
    for (const w of words) {
      const j = lower.indexOf(w, at)
      if (j >= 0 && (i < 0 || j < i || (j === i && w.length > len))) [i, len] = [j, w.length]
    }
    if (i < 0) return out
    out.push([i, i + len])
    at = i + len
  }
}

/** `text` with every case-insensitive occurrence of any word of `q` in <mark>, like the prototype's hl(). */
export function highlight(text: string, q: string): ReactNode {
  const ranges = matchRanges(text, q)
  if (!ranges.length) return text
  const out: ReactNode[] = []
  let at = 0
  for (const [i, end] of ranges) {
    out.push(text.slice(at, i), <mark key={i}>{text.slice(i, end)}</mark>)
    at = end
  }
  out.push(text.slice(at))
  return out
}

/** FTS snippets mark matches with [ and ]. */
function snippetNode(snippet: string): ReactNode {
  return snippet.split(/(\[[^\]]*\])/).map((part, i) =>
    part.startsWith('[') && part.endsWith(']') ? <mark key={i}>{part.slice(1, -1)}</mark> : part,
  )
}

function ago(z: ExtProps['z'], ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (min < 1) return z('刚刚更新')
  if (min < 60) return z(`${min} 分钟前更新`)
  if (min < 60 * 24) return z(`${Math.round(min / 60)} 小时前更新`)
  return z(`${Math.round(min / 1440)} 天前更新`)
}

/** Memory: CLAUDE.md files and auto memories, full-text search, auto memory and FTS switches. */
export function MemoryBody({ z, lang, flash, onOpenSession }: ExtProps & { onOpenSession?: (id: string) => void }) {
  const [data, setData] = useState<MemoryList>()
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'memory' | 'session'>('all')
  const [open, setOpen] = useState<string>()
  const [fts, setFts] = useState<{ q: string; memory: { id: string; snippet: string }[]; sessions: { session: string; snippet: string }[] }>()
  const load = () => ext.memory().then(setData, e => setError(errorText(e)))
  useEffect(() => {
    void load()
  }, [])
  const q = query.trim()
  const sq = !!data?.sqlite
  const eff = sq ? scope : 'memory'
  useEffect(() => {
    if (!sq || q.length < 2) return
    const timer = setTimeout(() => {
      ext.searchMemory(q, scope).then(
        r => {
          setFts({ q, memory: r.memory, sessions: r.sessions })
          // A search refreshes the index; show its new size and time.
          void load()
        },
        () => setFts(undefined),
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [q, scope, sq])
  if (error) return <p className="note">{error}</p>
  if (!data) return <p className="note">{z('加载中…')}</p>

  const title = (m: MemoryFile) => (TITLES[m.kind] ? z(TITLES[m.kind]!) : m.title)
  const where = (m: MemoryFile) => {
    if (m.kind !== 'auto' || !m.modified) return m.where
    const dt = new Date(m.modified)
    const date =
      lang === 'en'
        ? dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : `${dt.getMonth() + 1}月${dt.getDate()}日`
    return `${z('自动记忆')} · ${date}`
  }
  const ftsNow = fts && fts.q === q ? fts : undefined
  const words = queryWords(q)
  // Index hits first in rank order, then files that contain every word.
  const rank = (x: MemoryFile) => ftsNow?.memory.findIndex(h => h.id === x.id) ?? -1
  const order = (x: MemoryFile) => (rank(x) < 0 ? Number.MAX_SAFE_INTEGER : rank(x))
  const hits =
    eff === 'session'
      ? []
      : data.files
          .filter(x => {
            const hay = (title(x) + x.where + x.body).toLowerCase()
            return words.every(w => hay.includes(w)) || rank(x) >= 0
          })
          .sort((a, b) => order(a) - order(b))
  const tHits = sq && eff !== 'memory' && q.length >= 2 ? (ftsNow?.sessions ?? []) : []
  const m = hits.find(x => x.id === open) ?? hits[0]
  const snippet = (x: MemoryFile): ReactNode => {
    if (!q) return where(x)
    const line = x.body.split('\n').find(l => words.some(w => l.toLowerCase().includes(w)))
    if (line) return highlight(line.replace(/^(description|name):\s*/, '').slice(0, 60), q)
    // The index also matches the other Chinese script, which a plain substring search cannot.
    const hit = ftsNow?.memory.find(h => h.id === x.id)
    return hit ? snippetNode(hit.snippet.replace(/\s+/g, ' ').trim()) : where(x)
  }
  const toggle = async (key: 'autoMemory' | 'sqlite', on: boolean) => {
    try {
      await ext.setMemory(key, on)
      await load()
      if (key === 'autoMemory') flash(z(on ? '已开启自动记忆' : '已关闭自动记忆'))
    } catch (e) {
      flash(errorText(e))
    }
  }
  const index = data.index
  return (
    <>
      <div className="memsearch">
        <label htmlFor="mem-q" hidden>
          {z('搜索记忆')}
        </label>
        <input
          id="mem-q"
          placeholder={z('搜索记忆（全文检索，例如：评审、RULER）')}
          value={query}
          autoComplete="off"
          autoFocus
          onChange={e => setQuery(e.target.value)}
        />
        <Switch on={data.autoMemory} label={z('自动记忆')} title={z('自动记忆')} onToggle={() => void toggle('autoMemory', !data.autoMemory)} />
        <span className="note">{z('自动记忆')}</span>
        <span className="note">{z(`${hits.length + tHits.length} 条结果`)}</span>
        {sq && (
          <span className="seg" role="radiogroup" aria-label={z('搜索范围')}>
            {(
              [
                ['all', '全部'],
                ['memory', '记忆'],
                ['session', '历史会话'],
              ] as const
            ).map(([k, l]) => (
              <button type="button" role="radio" key={k} aria-checked={scope === k} onClick={() => setScope(k)}>
                {z(l)}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="memidx">
        <Switch on={sq} label={z('SQLite 全文索引')} onToggle={() => void toggle('sqlite', !sq)} />
        <span>{z('SQLite 全文索引')}</span>
        {sq ? (
          <>
            <span className="mono">{index?.path ?? '~/.claude/memory-index.sqlite'}</span>
            <span>
              {index?.builtAt
                ? `${z(`${index.files} 个文件 · ${index.chunks.toLocaleString('en-US')} 段`)} · ${ago(z, index.builtAt)}`
                : z('第一次搜索时建立索引')}
            </span>
          </>
        ) : (
          <span>{z('关闭时只搜记忆文件；打开后也能搜历史会话内容（memory.sqlite.enabled）')}</span>
        )}
      </div>
      <div className="memgrid">
        <div className="memlist" id="memlist">
          {hits.map(x => (
            <button type="button" key={x.id} data-mem={x.id} aria-current={x.id === m?.id} onClick={() => setOpen(x.id)}>
              {highlight(title(x), q)}
              <small>{snippet(x)}</small>
            </button>
          ))}
          {tHits.length > 0 && <div className="grp-h">{z('历史会话')}</div>}
          {tHits.map((h, i) => (
            <button type="button" key={`${h.session}-${i}`} data-memhit={h.session} onClick={() => onOpenSession?.(h.session)}>
              {h.session}
              <small>{snippetNode(h.snippet)}</small>
            </button>
          ))}
          {!hits.length && !tHits.length && (
            <p className="note" style={{ padding: '6px 8px' }}>
              {z(eff === 'session' && q.length < 2 ? '输入至少 2 个字搜索历史会话。' : '没有匹配的结果。')}
            </p>
          )}
        </div>
        <pre className="memview">{m ? highlight(m.body, q) : ''}</pre>
      </div>
    </>
  )
}
