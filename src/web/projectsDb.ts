/**
 * `<config>/web/projects.sqlite`: what the web sidebar and projects keep
 * besides the transcripts (docs/design/claude-web-project.md, section 5).
 * Transcripts stay the source of truth; deleting this file loses only
 * pins, renames, unread marks and project metadata.
 */
import type { Database } from 'bun:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * One entry per `PRAGMA user_version` step, applied in order inside a
 * transaction. Append new steps; never edit a released one.
 */
export const MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      title TEXT,
      pinned_at INTEGER,
      unread INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL
    )`,
    'CREATE TABLE folders (path TEXT PRIMARY KEY, last_touched INTEGER NOT NULL)',
  ],
]

const open = new Map<string, Database>()

export function migrate(db: Database, migrations = MIGRATIONS): void {
  const { user_version: version } = db.query('PRAGMA user_version').get() as { user_version: number }
  if (version > migrations.length) {
    throw new Error(`${db.filename} was written by a newer claude (schema ${version})`)
  }
  db.transaction(() => {
    for (const statements of migrations.slice(version)) {
      for (const sql of statements) db.run(sql)
    }
    // PRAGMA takes no bound parameters; the value is our own integer.
    db.run(`PRAGMA user_version = ${migrations.length}`)
  })()
}

/** The database at `path`, created and migrated on first use. */
export function projectsDb(path: string): Database {
  const cached = open.get(path)
  if (cached) return cached
  mkdirSync(dirname(path), { recursive: true })
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(path, { create: true })
  db.run('PRAGMA busy_timeout = 5000')
  db.run('PRAGMA journal_mode = WAL')
  migrate(db)
  open.set(path, db)
  return db
}

export function closeProjectsDb(path: string): void {
  open.get(path)?.close()
  open.delete(path)
}

export type SessionMeta = {
  title: string | null
  pinnedAt: number | null
  unread: boolean
  archivedAt: number | null
  projectId: string | null
}

type MetaRow = {
  session_id: string
  title: string | null
  pinned_at: number | null
  unread: number
  archived_at: number | null
  project_id: string | null
}

const toMeta = (row: MetaRow): SessionMeta => ({
  title: row.title,
  pinnedAt: row.pinned_at,
  unread: row.unread === 1,
  archivedAt: row.archived_at,
  projectId: row.project_id,
})

export function readSessionMeta(db: Database): Map<string, SessionMeta> {
  const rows = db.query('SELECT * FROM session_meta').all() as MetaRow[]
  return new Map(rows.map(row => [row.session_id, toMeta(row)]))
}

export type SessionMetaPatch = {
  title?: string | null
  pinned?: boolean
  unread?: boolean
  archived?: boolean
  project_id?: string | null
}

/** Applies `patch` to a session's row (created on first use) and returns the row. */
export function patchSessionMeta(db: Database, id: string, patch: SessionMetaPatch, now = Date.now()): SessionMeta {
  return db.transaction(() => {
    db.run('INSERT OR IGNORE INTO session_meta (session_id) VALUES (?)', [id])
    const row = db.query('SELECT * FROM session_meta WHERE session_id = ?').get(id) as MetaRow
    const next: MetaRow = {
      ...row,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.pinned !== undefined && { pinned_at: patch.pinned ? (row.pinned_at ?? now) : null }),
      ...(patch.unread !== undefined && { unread: patch.unread ? 1 : 0 }),
      ...(patch.archived !== undefined && { archived_at: patch.archived ? (row.archived_at ?? now) : null }),
      ...(patch.project_id !== undefined && { project_id: patch.project_id }),
    }
    db.run(
      'UPDATE session_meta SET title = ?, pinned_at = ?, unread = ?, archived_at = ?, project_id = ? WHERE session_id = ?',
      [next.title, next.pinned_at, next.unread, next.archived_at, next.project_id, id],
    )
    return toMeta(next)
  })()
}

export function deleteSessionMeta(db: Database, id: string): void {
  db.run('DELETE FROM session_meta WHERE session_id = ?', [id])
}

/** Whether a project with this id exists (the `projects` table arrives with projects). */
export function projectExists(db: Database, id: string): boolean {
  const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get()
  return !!table && !!db.query('SELECT 1 FROM projects WHERE id = ?').get(id)
}

export function readFolders(db: Database): Map<string, number> {
  const rows = db.query('SELECT path, last_touched FROM folders').all() as { path: string; last_touched: number }[]
  return new Map(rows.map(row => [row.path, row.last_touched]))
}

/** Raises each folder's `last_touched` to the given time; never lowers it. */
export function touchFolders(db: Database, touched: Map<string, number>): void {
  const upsert = db.prepare(
    'INSERT INTO folders (path, last_touched) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET last_touched = max(last_touched, excluded.last_touched)',
  )
  db.transaction(() => {
    for (const [path, at] of touched) upsert.run(path, at)
  })()
}
