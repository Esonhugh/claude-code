import type { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { SESSION_CONFIG_MIGRATION } from './sessionConfig.js'
import { TASK_MIGRATION } from './tasks.js'

/**
 * `~/.claude/web/projects.sqlite`: projects, tasks and the sidebar's marks
 * (docs/design/claude-web-project.md section 5). Only the server writes it;
 * the page goes through REST. Each entry of MIGRATIONS is one schema step,
 * applied in order and recorded in `PRAGMA user_version`.
 */
const MIGRATIONS: string[][] = [
  // P2: projects with their coordinator session.
  [
    `CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      worker_model TEXT,
      permission_mode TEXT NOT NULL DEFAULT 'default',
      coordinator_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )`,
  ],
  // P1: the sidebar's marks on sessions and its folder order cache.
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
  // P3: the coordinators' tasks, and the coordinator's own model and effort.
  TASK_MIGRATION,
  // What earlier runs of a resumed task took, so its time adds up across runs.
  ['ALTER TABLE tasks ADD COLUMN prior_ms INTEGER NOT NULL DEFAULT 0'],
  // The task default effort, next to the task default model.
  ['ALTER TABLE projects ADD COLUMN worker_effort TEXT'],
  // Per-session plugins/MCP/channels/hooks and the profiles they can start from (#796).
  SESSION_CONFIG_MIGRATION,
]

export type Project = {
  id: string
  name: string
  cwd: string
  instructions: string
  worker_model: string | null
  /** CLAUDE_CODE_SUBAGENT_EFFORT for the coordinator's workers; null inherits the coordinator's. */
  worker_effort: string | null
  permission_mode: string
  coordinator_session_id: string | null
  /** The coordinator's model and effort as last changed from its input box; kept across restarts. */
  coordinator_model: string | null
  coordinator_effort: string | null
  created_at: number
  updated_at: number
  archived_at: number | null
}

export type ProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'instructions'
    | 'worker_model'
    | 'worker_effort'
    | 'permission_mode'
    | 'coordinator_session_id'
    | 'coordinator_model'
    | 'coordinator_effort'
  >
>

export function openProjectsDb(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(path, { create: true })
  db.run('PRAGMA busy_timeout = 5000')
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  const { user_version: version } = db.query('PRAGMA user_version').get() as { user_version: number }
  for (let step = version; step < MIGRATIONS.length; step++) {
    db.transaction(() => {
      for (const sql of MIGRATIONS[step]!) db.run(sql)
      db.run(`PRAGMA user_version = ${step + 1}`)
    })()
  }
  return db
}

export class ProjectStore {
  constructor(private db: Database) {}

  list(): Project[] {
    return this.db
      .query('SELECT * FROM projects WHERE archived_at IS NULL ORDER BY updated_at DESC')
      .all() as Project[]
  }

  get(id: string): Project | undefined {
    return (this.db.query('SELECT * FROM projects WHERE id = ?').get(id) as Project | null) ?? undefined
  }

  create(input: Pick<Project, 'name' | 'cwd' | 'instructions' | 'worker_model' | 'worker_effort' | 'permission_mode'>): Project {
    const now = Date.now()
    const id = randomUUID()
    this.db.run(
      `INSERT INTO projects (id, name, cwd, instructions, worker_model, worker_effort, permission_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.name, input.cwd, input.instructions, input.worker_model, input.worker_effort, input.permission_mode, now, now],
    )
    return this.get(id)!
  }

  update(id: string, patch: ProjectPatch): Project | undefined {
    const keys = Object.keys(patch).filter(k => patch[k as keyof ProjectPatch] !== undefined) as (keyof ProjectPatch)[]
    if (keys.length) {
      this.db.run(
        `UPDATE projects SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND archived_at IS NULL`,
        [...keys.map(k => patch[k] ?? null), Date.now(), id],
      )
    }
    const project = this.get(id)
    return project && project.archived_at === null ? project : undefined
  }

  /** Deletes the project row; sessions moved into it go back to their folders. */
  remove(id: string): Project | undefined {
    const project = this.get(id)
    if (project) this.db.run('DELETE FROM projects WHERE id = ?', [id])
    return project
  }

  archive(id: string): Project | undefined {
    const project = this.get(id)
    if (!project || project.archived_at !== null) return undefined
    this.db.run('UPDATE projects SET archived_at = ? WHERE id = ?', [Date.now(), id])
    return project
  }
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

/** Session ids of project coordinators; their transcripts belong to the project, not a folder. */
export function coordinatorSessionIds(db: Database): Set<string> {
  const rows = db
    .query('SELECT coordinator_session_id AS id FROM projects WHERE coordinator_session_id IS NOT NULL')
    .all() as { id: string }[]
  return new Set(rows.map(r => r.id))
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
