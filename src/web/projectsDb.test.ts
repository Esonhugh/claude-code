import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { coordinatorSpawn } from './coordinator.js'
import {
  coordinatorSessionIds,
  deleteSessionMeta,
  openProjectsDb,
  patchSessionMeta,
  ProjectStore,
  readFolders,
  readSessionMeta,
  touchFolders,
} from './projectsDb.js'

const input = { name: 'A', cwd: '/tmp', instructions: '', worker_model: null, permission_mode: 'default' }

describe('projects database', () => {
  it('migrates once and keeps rows across reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'web-pdb-')), 'web', 'projects.sqlite')
    const db = openProjectsDb(path)
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    const created = new ProjectStore(db).create(input)
    db.close()
    const again = openProjectsDb(path)
    expect((again.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
    expect(new ProjectStore(again).get(created.id)).toEqual(created)
    again.close()
  })

  it('creates, updates, lists newest change first and archives', () => {
    const store = new ProjectStore(openProjectsDb(':memory:'))
    const a = store.create(input)
    const b = store.create({ ...input, name: 'B', worker_model: 'opus' })
    expect(a.archived_at).toBeNull()
    expect(b.worker_model).toBe('opus')
    const updated = store.update(a.id, { name: 'A2', worker_model: null, coordinator_session_id: 's1', instructions: undefined })!
    expect(updated).toMatchObject({ name: 'A2', worker_model: null, coordinator_session_id: 's1', instructions: '' })
    expect(updated.updated_at).toBeGreaterThanOrEqual(a.updated_at)
    expect(store.list().map(p => p.id)).toContain(a.id)
    expect(store.archive(a.id)?.id).toBe(a.id)
    expect(store.archive(a.id)).toBeUndefined()
    expect(store.list().map(p => p.id)).toEqual([b.id])
    expect(store.update(a.id, { name: 'x' })).toBeUndefined()
    expect(store.get(a.id)?.name).toBe('A2')
  })
})

const ID = '11111111-2222-4333-8444-555555555555'

describe('sidebar marks', () => {
  it('patches session marks, keeping the first pin and archive time', () => {
    const db = openProjectsDb(':memory:')
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
    expect(readSessionMeta(db).get(ID)).toEqual({ title: null, pinnedAt: null, unread: false, archivedAt: 300, projectId: null })
    deleteSessionMeta(db, ID)
    expect(readSessionMeta(db).size).toBe(0)
  })

  it('moves a session into a project and back out when the project is deleted', () => {
    const db = openProjectsDb(':memory:')
    const store = new ProjectStore(db)
    const project = store.create(input)
    expect(() => patchSessionMeta(db, ID, { project_id: 'missing' })).toThrow()
    patchSessionMeta(db, ID, { project_id: project.id })
    store.update(project.id, { coordinator_session_id: 'c1' })
    expect(coordinatorSessionIds(db)).toEqual(new Set(['c1']))
    expect(store.remove(project.id)?.id).toBe(project.id)
    expect(readSessionMeta(db).get(ID)?.projectId).toBeNull()
  })

  it('only moves a folder last-touched time forward', () => {
    const db = openProjectsDb(':memory:')
    touchFolders(db, new Map([['/a', 200], ['/b', 50]]))
    touchFolders(db, new Map([['/a', 100]]))
    expect(readFolders(db)).toEqual(new Map([['/a', 200], ['/b', 50]]))
  })
})

describe('coordinatorSpawn', () => {
  it('passes the coordinator prompt, the project instructions and the task model', () => {
    const spawn = coordinatorSpawn({ instructions: '  Cite sources.\n', worker_model: 'sonnet' })
    expect(spawn.systemPrompt).toContain('You are a **coordinator**')
    expect(spawn.systemPrompt).toContain('**Agent** - Spawn a new worker')
    expect(spawn.appendSystemPrompt).toBe('Cite sources.')
    expect(spawn.env).toEqual({ CLAUDE_CODE_COORDINATOR_MODE: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' })
  })

  it('leaves out empty instructions and an inherited model', () => {
    const spawn = coordinatorSpawn({ instructions: ' ', worker_model: null })
    expect(spawn.appendSystemPrompt).toBeUndefined()
    expect(spawn.env).toEqual({ CLAUDE_CODE_COORDINATOR_MODE: '1' })
  })
})
