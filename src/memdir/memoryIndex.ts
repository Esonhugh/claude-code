/**
 * Local SQLite FTS5 index over auto-memory files and session transcripts,
 * used by SearchMemory when memory.sqlite.enabled is on.
 *
 * Files stay the source of truth: every search re-indexes the files whose
 * mtime or size changed and drops rows for files that disappeared, so the
 * index is only a cache and can be deleted at any time.
 */
import type { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { open, readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join, resolve, sep } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getProjectDir, getProjectsDir } from '../utils/sessionStorage.js'
import { foldForSearch } from './searchFold.js'
import { getAutoMemPath, type SqliteMemoryScope } from './paths.js'

export type MemoryScope = SqliteMemoryScope

export type MemorySearchHit = {
  path: string
  kind: 'memory' | 'transcript'
  /** Transcript line number (1-based); 0 for memory files. */
  line: number
  /** Text around the match, the matched word in [ and ]. */
  snippet: string
  /** Where the bracketed match sits in `snippet`, brackets included; absent without one. */
  match?: [number, number]
}

export type MemoryIndexStatus = {
  path: string
  built: boolean
  builtAt?: number
  files: number
  chunks: number
  bytes: number
}

type SourceFile = { path: string; kind: 'memory' | 'transcript'; project: string }
type Listing = { files: SourceFile[]; dirs: { dir: string; recursive: boolean }[] }
type FileRow = { path: string; mtime: number; size: number; lines: number }

// Bump when the tables or tokenizer change; an older index is dropped and rebuilt.
const SCHEMA_VERSION = '3'
// A transcript message longer than this is indexed by its head only.
const MAX_CHUNK_CHARS = 4000
// trigram needs at least three characters per term.
const MIN_TRIGRAM_CHARS = 3
// A long pasted prompt is searched by its first words only.
const MAX_QUERY_WORDS = 200
// Files whose changes are written in one transaction: one commit per file made
// a first build of 10,000 memory files take ~30 s (#1105).
const REFRESH_BATCH_FILES = 500

let db: Database | undefined
let dbPath: string | undefined

export function defaultIndexPath(): string {
  return join(getClaudeConfigHomeDir(), 'memory-index.sqlite')
}

function openIndex(): Database {
  if (db) return db
  const path = dbPath ?? defaultIndexPath()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const index = new Database(path, { create: true })
  // Several sessions share one index; wait for a writer instead of failing.
  index.run('PRAGMA busy_timeout = 5000')
  index.run('PRAGMA journal_mode = WAL')
  index.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  const version = index.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | null
  if (version?.value !== SCHEMA_VERSION) {
    index.run('DROP TABLE IF EXISTS files')
    index.run('DROP TABLE IF EXISTS chunks')
    index.run('DELETE FROM meta')
    index.run("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION])
  }
  index.run('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER, lines INTEGER)')
  index.run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(body, text UNINDEXED, path UNINDEXED, kind UNINDEXED, project UNINDEXED, line UNINDEXED, tokenize = 'trigram')",
  )
  db = index
  return index
}

/** Test hook: point the index at another file (or ':memory:'). */
export function resetMemoryIndexForTesting(path?: string): void {
  db?.close()
  db = undefined
  dbPath = path
}

async function listDir(dir: string, recursive = false): Promise<string[]> {
  try {
    return await readdir(dir, { recursive })
  } catch {
    return []
  }
}

async function listSources(scopes: readonly MemoryScope[]): Promise<Listing> {
  const listing: Listing = { files: [], dirs: [] }
  const projectDir = getProjectDir(getOriginalCwd())
  const project = basename(projectDir)
  const autoMemDir = resolve(getAutoMemPath())
  if (scopes.includes('project')) {
    // Recursive: team memory and daily logs live in subdirectories.
    listing.dirs.push({ dir: autoMemDir, recursive: true })
    for (const name of await listDir(autoMemDir, true)) {
      if (name.endsWith('.md')) listing.files.push({ path: join(autoMemDir, name), kind: 'memory', project })
    }
  }
  if (scopes.includes('session')) {
    // The running session is already in context; only past sessions count.
    const current = `${getSessionId()}.jsonl`
    listing.dirs.push({ dir: resolve(projectDir), recursive: false })
    for (const name of await listDir(projectDir)) {
      if (name.endsWith('.jsonl') && name !== current) {
        listing.files.push({ path: join(projectDir, name), kind: 'transcript', project })
      }
    }
  }
  if (scopes.includes('user')) {
    for (const name of await listDir(getProjectsDir())) {
      const memDir = join(getProjectsDir(), name, 'memory')
      if (resolve(memDir) === autoMemDir) continue
      listing.dirs.push({ dir: resolve(memDir), recursive: true })
      for (const file of await listDir(memDir, true)) {
        if (file.endsWith('.md')) listing.files.push({ path: join(memDir, file), kind: 'memory', project: name })
      }
    }
  }
  return listing
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block =>
      block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

/** User and assistant text from transcript lines, one chunk per message. */
export function transcriptChunks(raw: string, firstLine = 1): { line: number; body: string }[] {
  const chunks: { line: number; body: string }[] = []
  raw.split('\n').forEach((text, i) => {
    if (!text.startsWith('{')) return
    let entry: { type?: string; isMeta?: boolean; message?: { content?: unknown } }
    try {
      entry = JSON.parse(text)
    } catch {
      return
    }
    // isMeta user entries are harness injections (reminders, hook output), not the user.
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta) return
    const body = messageText(entry.message?.content).trim()
    if (body) chunks.push({ line: firstLine + i, body: `${entry.type}: ${body.slice(0, MAX_CHUNK_CHARS)}` })
  })
  return chunks
}

async function readFrom(path: string, start: number, end: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(end - start)
    await handle.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function refresh(index: Database, files: SourceFile[]): Promise<void> {
  const known = new Map(
    (index.query('SELECT path, mtime, size, lines FROM files').all() as FileRow[]).map(row => [row.path, row]),
  )
  const insert = index.prepare('INSERT INTO chunks (body, text, path, kind, project, line) VALUES (?, ?, ?, ?, ?, ?)')
  type Pending = { file: SourceFile; prev?: FileRow; append: boolean; chunks: { line: number; body: string }[]; mtime: number; size: number; lines: number }
  let pending: Pending[] = []
  // IMMEDIATE takes the write lock before the reads below, so a busy DB waits
  // on busy_timeout instead of failing with SQLITE_BUSY on lock upgrade.
  const flush = () => {
    const batch = pending
    pending = []
    if (batch.length === 0) return
    index.transaction(() => {
      for (const { file, prev, append, chunks, mtime, size, lines } of batch) {
        if (append) {
          // Another session, or a concurrent search in this one, may have appended these lines since `known` was read.
          const current = index.query('SELECT size, lines FROM files WHERE path = ?').get(file.path) as FileRow | null
          if (current?.size !== prev!.size || current.lines !== prev!.lines) continue
        } else if (prev) {
          // path is UNINDEXED, so this scans every chunk: only a file indexed before has rows to drop.
          index.run('DELETE FROM chunks WHERE path = ?', [file.path])
        }
        for (const chunk of chunks) {
          // body is searched folded (simplified script, no accents); text keeps the original for snippets.
          const folded = foldForSearch(chunk.body)
          insert.run(folded, folded === chunk.body ? null : chunk.body, file.path, file.kind, file.project, chunk.line)
        }
        index.run('INSERT OR REPLACE INTO files (path, mtime, size, lines) VALUES (?, ?, ?, ?)', [file.path, mtime, size, lines])
      }
    }).immediate()
  }
  for (const file of files) {
    let info
    try {
      info = await stat(file.path)
    } catch {
      continue
    }
    const prev = known.get(file.path)
    if (prev && prev.mtime === info.mtimeMs && prev.size === info.size) continue
    // Transcripts are append-only: index just the new lines when the file grew.
    const append = file.kind === 'transcript' && prev !== undefined && info.size > prev.size
    let raw: string
    try {
      raw = append ? await readFrom(file.path, prev.size, info.size) : await readFile(file.path, 'utf8')
    } catch {
      continue
    }
    let size = info.size
    let lines = 0
    let chunks: { line: number; body: string }[]
    if (file.kind === 'memory') {
      chunks = [{ line: 0, body: raw }]
    } else {
      // Leave a half-written last line for the next refresh.
      const end = raw.lastIndexOf('\n') + 1
      size = (append ? prev.size : 0) + Buffer.byteLength(raw.slice(0, end))
      const complete = raw.slice(0, end)
      lines = (append ? prev.lines : 0) + (complete.match(/\n/g)?.length ?? 0)
      chunks = transcriptChunks(complete, (append ? prev.lines : 0) + 1)
    }
    pending.push({ file, prev, append, chunks, mtime: size === info.size ? info.mtimeMs : 0, size, lines })
    if (pending.length >= REFRESH_BATCH_FILES) flush()
  }
  flush()
}

function forget(index: Database, path: string): void {
  index.run('DELETE FROM chunks WHERE path = ?', [path])
  index.run('DELETE FROM files WHERE path = ?', [path])
}

function isUnder(path: string, dirs: Listing['dirs']): boolean {
  return dirs.some(({ dir, recursive }) => (recursive ? path.startsWith(dir + sep) : dirname(path) === dir))
}

function prune(index: Database, { files, dirs }: Listing): void {
  // A file gone from a directory that was just listed has been deleted.
  const live = new Set(files.map(f => f.path))
  for (const { path } of index.query('SELECT path FROM files').all() as { path: string }[]) {
    if (!live.has(path) && isUnder(path, dirs)) forget(index, path)
  }
}

// Korean spaces words but attaches particles, so it splits like Chinese and Japanese.
const CJK_OR_OTHER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Chinese and Japanese write words without spaces, so a whole sentence would
 * be one phrase that never matches. Split such runs into overlapping
 * two-character pieces (most words are two characters) and trigrams; any of
 * them may match, and chunks sharing more of them rank first.
 */
function splitCjk(word: string): string[] {
  return (word.match(CJK_OR_OTHER) ?? []).flatMap(part => {
    const chars = [...part]
    if (!CJK_CHAR.test(part) || chars.length <= 2) return [part]
    const grams = (n: number) => Array.from({ length: chars.length - n + 1 }, (_, i) => chars.slice(i, i + n).join(''))
    return [...grams(2), ...grams(MIN_TRIGRAM_CHARS)]
  })
}

/** Long enough for trigram, or a two-character CJK word. */
function isDistinctive(word: string): boolean {
  const length = [...word].length
  return length >= MIN_TRIGRAM_CHARS || (length === 2 && hasCjk(word))
}

/** True when a prompt has CJK text, which carries several words without spaces. */
export function hasCjk(text: string): boolean {
  return CJK_CHAR.test(text)
}

function terms(query: string): string[] {
  return [...new Set(foldForSearch(query).split(/\s+/).filter(Boolean).flatMap(splitCjk))]
}

export async function searchMemory(params: {
  query: string
  scopes: readonly MemoryScope[]
  limit: number
}): Promise<MemorySearchHit[]> {
  const index = openIndex()
  const listing = await listSources(params.scopes)
  const { files } = listing
  await refresh(index, files)
  prune(index, listing)

  const words = terms(params.query)
  if (words.length === 0) return []
  const paths = files.map(f => f.path)
  if (paths.length === 0) return []
  const rows = rankChunks(index, paths, words, params.limit, true)
  return rows.map(({ body, text, ...hit }) => ({ ...hit, ...snippetAround(body ?? '', text ?? body ?? '', words) }))
}

type ChunkRow = { path: string; kind: MemorySearchHit['kind']; line: number; body: string | null; text: string | null }

/**
 * Chunks in `paths` holding any of `words`, those holding more of the words
 * first, then by bm25. trigram MATCH serves words of three or more
 * characters; shorter ones (most Chinese words) fall back to LIKE.
 */
function rankChunks(index: Database, paths: string[], query: string[], limit: number, withBody: boolean): ChunkRow[] {
  // Next to long words, short Latin words and single characters match nearly everything.
  const usable = query.some(w => [...w].length >= MIN_TRIGRAM_CHARS) ? query.filter(isDistinctive) : query
  // Each word adds to the SQL expression, which SQLite caps at depth 1000.
  const words = usable.slice(0, MAX_QUERY_WORDS)
  const long = words.filter(w => [...w].length >= MIN_TRIGRAM_CHARS)
  const short = words.filter(w => [...w].length < MIN_TRIGRAM_CHARS)
  const args: (string | number)[] = []
  let fts = 'SELECT NULL AS id, NULL AS rank'
  if (long.length > 0) {
    fts = 'SELECT rowid AS id, bm25(chunks) AS rank FROM chunks WHERE chunks MATCH ?'
    // Quoted phrases keep FTS5 operators in user text literal.
    args.push(long.map(w => `"${w.replaceAll('"', '""')}"`).join(' OR '))
  }
  args.push(...paths)
  const any = [...(long.length > 0 ? ['m.id IS NOT NULL'] : []), ...short.map(() => "c.body LIKE ? ESCAPE '\\'")]
  for (const w of short) args.push(`%${w.replace(/[\\%_]/g, c => `\\${c}`)}%`)
  const covered = words.map(() => '(instr(lower(c.body), lower(?)) > 0)').join(' + ')
  args.push(...words, limit)
  return index
    .query(
      // MATERIALIZED runs MATCH once; a flattened subquery re-runs it for every row.
      `WITH m AS MATERIALIZED (${fts})
       SELECT c.path, c.kind, c.line, ${withBody ? 'c.body, c.text' : 'NULL AS body, NULL AS text'}
       FROM chunks c LEFT JOIN m ON m.id = c.rowid
       WHERE c.path IN (${paths.map(() => '?').join(',')}) AND (${any.join(' OR ')})
       ORDER BY ${covered} DESC, m.rank, c.rowid DESC LIMIT ?`,
    )
    .all(...args) as ChunkRow[]
}

/**
 * A window of the original `text` around the first query word that the
 * searched `body` contains, the word in brackets. FTS5 snippet() counts
 * trigram tokens, which leaves ~24 characters. Folding keeps lengths, so an
 * offset in `body` is the same offset in `text`.
 */
function snippetAround(body: string, text: string, words: string[]): Pick<MemorySearchHit, 'snippet' | 'match'> {
  const lower = body.toLowerCase()
  const word = words.find(w => lower.includes(w.toLowerCase()))
  if (!word) return { snippet: text.slice(0, 200) }
  const at = lower.indexOf(word.toLowerCase())
  const end = at + word.length
  const start = Math.max(0, at - 80)
  const before = `${start > 0 ? '…' : ''}${text.slice(start, at)}`
  return {
    snippet: `${before}[${text.slice(at, end)}]${text.slice(end, end + 100)}${end + 100 < text.length ? '…' : ''}`,
    match: [before.length, before.length + end - at + 2],
  }
}

// Words too common in prompts or memory frontmatter to signal relevance.
/** Chunks read per prompt to count which memory files hold each word. */
const MAX_RECALL_CHUNKS = 2000

const RECALL_STOPWORDS = new Set(
  (
    'the and for are but not you your yours was were has have had what when where which who whom why how ' +
    'this that these those with from into onto about over under then than them they their there here ' +
    'can could should would will shall may might must does did doing done just also only very more most ' +
    'some any all each every our ours its let get got use using used make made want need please ' +
    'tell show give know think say said like one two new now out off again still been being ' +
    'time times thanks thank good great fine okay sure yes look looks seem seems right ' +
    'name description metadata type project user feedback reference memory memories answer short sentence ' +
    '什麼 什么 怎麼 怎么 為什 为什 是不 不是 可以 一下 我們 我们 你們 你们 這個 这个 那個 那个 沒有 没有 有沒 有没'
  ).split(' '),
)

/** A word in more memory files than this carries no signal for recall. */
function commonWordFiles(fileCount: number): number {
  return Math.max(3, fileCount / 3)
}

/** Latin words must match whole, so `time` does not recall `runtime`; CJK pieces have no word boundaries. */
function wordMatcher(word: string): (body: string) => boolean {
  if (hasCjk(word)) return body => body.includes(word)
  // Prompt words hold only letters, digits, `_` and `-`, none of them special here.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${word}(?![\\p{L}\\p{N}_])`, 'u')
  return body => pattern.test(body)
}

/**
 * Memory files that match a user prompt, best first, for automatic recall:
 * no model call, only distinctive prompt words, memory files only. A file
 * needs a whole-word match on a word that few memory files share.
 */
export async function findMemoryFilesForPrompt(params: {
  prompt: string
  scopes: readonly MemoryScope[]
  exclude: ReadonlySet<string>
  limit: number
}): Promise<{ path: string; mtimeMs: number }[]> {
  const words = [
    ...new Set(
      foldForSearch(params.prompt)
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .flatMap(splitCjk)
        .filter(w => isDistinctive(w) && !RECALL_STOPWORDS.has(w)),
    ),
  ]
  if (words.length === 0) return []
  const index = openIndex()
  const listing = await listSources(params.scopes.filter(s => s !== 'session'))
  await refresh(index, listing.files)
  prune(index, listing)
  const paths = listing.files.map(f => f.path).filter(p => basename(p) !== 'MEMORY.md')
  if (paths.length === 0) return []
  const matchers = words.map(wordMatcher)
  const matched = new Map<string, Set<number>>()
  for (const row of rankChunks(index, paths, words, MAX_RECALL_CHUNKS, true)) {
    const body = row.body!.toLowerCase()
    const found = matched.get(row.path) ?? new Set<number>()
    matchers.forEach((match, i) => {
      if (match(body)) found.add(i)
    })
    matched.set(row.path, found)
  }
  const fileCounts = words.map((_, i) => [...matched.values()].filter(found => found.has(i)).length)
  const rare = (i: number) => fileCounts[i]! <= commonWordFiles(paths.length)
  const known = new Map(
    (index.query('SELECT path, mtime FROM files').all() as { path: string; mtime: number }[]).map(r => [r.path, r.mtime]),
  )
  // Map order is rankChunks order, so ties keep the bm25 ranking.
  return [...matched]
    .filter(([path]) => !params.exclude.has(path))
    .map(([path, found]) => ({ path, score: [...found].filter(rare).length }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map(r => ({ path: r.path, mtimeMs: known.get(r.path) ?? 0 }))
}

/**
 * Rebuild the index from scratch: rows for deleted or out-of-scope files
 * (transcripts may hold sensitive text) and any stale or polluted rows are
 * gone, then the DB is compacted.
 */
export async function buildMemoryIndex(scopes: readonly MemoryScope[]): Promise<MemoryIndexStatus> {
  const index = openIndex()
  const listing = await listSources(scopes)
  index.transaction(() => {
    index.run('DELETE FROM chunks')
    index.run('DELETE FROM files')
  })()
  await refresh(index, listing.files)
  index.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('built_at', ?)", [String(Date.now())])
  index.run('VACUUM')
  return getMemoryIndexStatus()
}

/** Rows that index one project's memory and transcripts; `claude purge` removes them. */
export function countProjectIndexRows(projectDir: string): number {
  return projectIndexRows(projectDir, false)
}

export function deleteProjectIndexRows(projectDir: string): void {
  projectIndexRows(projectDir, true)
}

function projectIndexRows(projectDir: string, remove: boolean): number {
  const path = dbPath ?? defaultIndexPath()
  // Never create an index just to purge it.
  if (!db && (path === ':memory:' || !existsSync(path))) return 0
  const index = openIndex()
  const project = basename(projectDir)
  const prefix = resolve(projectDir) + sep
  const where = 'substr(path, 1, ?) = ?'
  const args = [prefix.length, prefix] as const
  if (remove) {
    index.transaction(() => {
      index.run(`DELETE FROM chunks WHERE project = ? OR ${where}`, [project, ...args])
      index.run(`DELETE FROM files WHERE ${where}`, [...args])
    })()
    return 0
  }
  const chunks = index.query(`SELECT count(*) AS n FROM chunks WHERE project = ? OR ${where}`).get(project, ...args) as { n: number }
  const files = index.query(`SELECT count(*) AS n FROM files WHERE ${where}`).get(...args) as { n: number }
  return chunks.n + files.n
}

export function getMemoryIndexStatus(): MemoryIndexStatus {
  const path = dbPath ?? defaultIndexPath()
  if (!db && (path === ':memory:' || !existsSync(path))) {
    return { path, built: false, files: 0, chunks: 0, bytes: 0 }
  }
  const index = openIndex()
  const builtAt = index.query("SELECT value FROM meta WHERE key = 'built_at'").get() as { value: string } | null
  const count = (sql: string) => (index.query(sql).get() as { n: number }).n
  const page = (name: string) => (index.query(`PRAGMA ${name}`).get() as Record<string, number>)[name] ?? 0
  return {
    path,
    built: builtAt !== null,
    builtAt: builtAt ? Number(builtAt.value) : undefined,
    files: count('SELECT count(*) AS n FROM files'),
    chunks: count('SELECT count(*) AS n FROM chunks'),
    bytes: page('page_count') * page('page_size'),
  }
}
