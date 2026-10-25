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
import { getAutoMemPath, type SqliteMemoryScope } from './paths.js'

export type MemoryScope = SqliteMemoryScope

export type MemorySearchHit = {
  path: string
  kind: 'memory' | 'transcript'
  /** Transcript line number (1-based); 0 for memory files. */
  line: number
  snippet: string
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
const SCHEMA_VERSION = '1'
// A transcript message longer than this is indexed by its head only.
const MAX_CHUNK_CHARS = 4000
// trigram needs at least three characters per term.
const MIN_TRIGRAM_CHARS = 3

let db: Database | undefined
let dbPath: string | undefined

function defaultIndexPath(): string {
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
    "CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(body, path UNINDEXED, kind UNINDEXED, project UNINDEXED, line UNINDEXED, tokenize = 'trigram')",
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
  const insert = index.prepare('INSERT INTO chunks (body, path, kind, project, line) VALUES (?, ?, ?, ?, ?)')
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
    index.transaction(() => {
      if (!append) index.run('DELETE FROM chunks WHERE path = ?', [file.path])
      for (const chunk of chunks) insert.run(chunk.body, file.path, file.kind, file.project, chunk.line)
      index.run('INSERT OR REPLACE INTO files (path, mtime, size, lines) VALUES (?, ?, ?, ?)', [
        file.path,
        size === info.size ? info.mtimeMs : 0,
        size,
        lines,
      ])
    })()
  }
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

function terms(query: string): string[] {
  return query.split(/\s+/).map(t => t.trim()).filter(Boolean)
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
  const inPaths = `path IN (${paths.map(() => '?').join(',')})`

  // Any word may match; bm25 ranks chunks matching more of them first.
  // Short words only filter when there is no word long enough for trigram.
  const long = words.filter(w => [...w].length >= MIN_TRIGRAM_CHARS)
  const args: (string | number)[] = [...paths]
  let match: string
  if (long.length > 0) {
    match = 'chunks MATCH ?'
    // Quoted phrases keep FTS5 operators in user text literal.
    args.push(long.map(w => `"${w.replaceAll('"', '""')}"`).join(' OR '))
  } else {
    match = `(${words.map(() => "body LIKE ? ESCAPE '\\'").join(' OR ')})`
    for (const w of words) args.push(`%${w.replace(/[\\%_]/g, c => `\\${c}`)}%`)
  }
  const order = long.length > 0 ? 'ORDER BY bm25(chunks)' : 'ORDER BY rowid DESC'
  const snippet = long.length > 0 ? "snippet(chunks, 0, '[', ']', '…', 24)" : 'substr(body, 1, 200)'
  args.push(params.limit)
  return index
    .query(`SELECT path, kind, line, ${snippet} AS snippet FROM chunks WHERE ${inPaths} AND ${match} ${order} LIMIT ?`)
    .all(...args) as MemorySearchHit[]
}

// Words too common in prompts or memory frontmatter to signal relevance.
const RECALL_STOPWORDS = new Set(
  (
    'the and for are but not you your yours was were has have had what when where which who whom why how ' +
    'this that these those with from into onto about over under then than them they their there here ' +
    'can could should would will shall may might must does did doing done just also only very more most ' +
    'some any all each every our ours its let get got use using used make made want need please ' +
    'tell show give know think say said like one two new now out off again still been being ' +
    'name description metadata type project user feedback reference memory memories answer short sentence'
  ).split(' '),
)

/**
 * Memory files that match a user prompt, best first, for automatic recall:
 * no model call, only distinctive prompt words, memory files only.
 */
export async function findMemoryFilesForPrompt(params: {
  prompt: string
  scopes: readonly MemoryScope[]
  exclude: ReadonlySet<string>
  limit: number
}): Promise<{ path: string; mtimeMs: number }[]> {
  const words = [
    ...new Set(
      params.prompt
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter(w => [...w].length >= MIN_TRIGRAM_CHARS && !RECALL_STOPWORDS.has(w)),
    ),
  ]
  if (words.length === 0) return []
  const index = openIndex()
  const listing = await listSources(params.scopes.filter(s => s !== 'session'))
  await refresh(index, listing.files)
  prune(index, listing)
  const paths = listing.files
    .map(f => f.path)
    .filter(p => basename(p) !== 'MEMORY.md' && !params.exclude.has(p))
  if (paths.length === 0) return []
  const rows = index
    .query(
      `SELECT path FROM chunks WHERE path IN (${paths.map(() => '?').join(',')}) AND chunks MATCH ? ORDER BY bm25(chunks) LIMIT ?`,
    )
    .all(...paths, words.map(w => `"${w.replaceAll('"', '""')}"`).join(' OR '), params.limit) as { path: string }[]
  const known = new Map(
    (index.query('SELECT path, mtime FROM files').all() as { path: string; mtime: number }[]).map(r => [r.path, r.mtime]),
  )
  return rows.map(r => ({ path: r.path, mtimeMs: known.get(r.path) ?? 0 }))
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
