import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  closeProjectsDb,
  deleteSessionMeta,
  MIGRATIONS,
  migrate,
  patchSessionMeta,
  projectExists,
  projectsDb,
  readFolders,
  readSessionMeta,
  touchFolders,
} from './projectsDb.js'

const ID = '11111111-2222-4333-8444-555555555555'
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeProjectsDb(join(dir, 'web', 'projects.sqlite'))
    rmSync(dir, { recursive: true, force: true })
  }
})

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'web-projects-db-'))
  dirs.push(dir)
  return projectsDb(join(dir, 'web', 'projects.sqlite'))
}

describe('projectsDb', () => {
  it('creates the file, the tables and the schema version', () => {
    const db = openTemp()
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      t => t.name,
    )
    expect(tables).toEqual(expect.arrayContaining(['session_meta', 'folders']))
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.length })
  })

  it('applies only the steps after the stored version, and refuses a newer file', () => {
    const db = new Database(':memory:')
    migrate(db, [['CREATE TABLE a (x)']])
    migrate(db, [['CREATE TABLE a (x)'], ['CREATE TABLE b (y)']])
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    expect(() => migrate(db, [['CREATE TABLE a (x)']])).toThrow(/newer/)
  })

  it('patches session marks, keeping the first pin and archive time', () => {
    const db = openTemp()
    expect(patchSessionMeta(db, ID, { pinned: true, unread: true }, 100)).toEqual({
      title: null,
      pinnedAt: 100,
      unread: true,
      archivedAt: null,
      projectId: null,
    })
    patchSessionMeta(db, ID, { pinned: true, title: 'Renamed' }, 200)
    expect(readSessionMeta(db).get(ID)).toMatchObject({ pinnedAt: 100, title: 'Renamed', unread: true })
    patchSessionMeta(db, ID, { pinned: false, unread: false, archived: true, title: null }, 300)
    expect(readSessionMeta(db).get(ID)).toEqual({
      title: null,
      pinnedAt: null,
      unread: false,
      archivedAt: 300,
      projectId: null,
    })
    deleteSessionMeta(db, ID)
    expect(readSessionMeta(db).size).toBe(0)
  })

  it('knows no project before the projects table exists', () => {
    expect(projectExists(openTemp(), 'p1')).toBe(false)
  })

  it('only moves a folder last-touched time forward', () => {
    const db = openTemp()
    touchFolders(db, new Map([['/a', 200], ['/b', 50]]))
    touchFolders(db, new Map([['/a', 100]]))
    expect(readFolders(db)).toEqual(new Map([['/a', 200], ['/b', 50]]))
  })
})
