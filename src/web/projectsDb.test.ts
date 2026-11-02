import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { coordinatorSpawn } from './coordinator.js'
import { openProjectsDb, ProjectStore } from './projectsDb.js'

const input = { name: 'A', cwd: '/tmp', instructions: '', worker_model: null, permission_mode: 'default' }

describe('projects database', () => {
  it('migrates once and keeps rows across reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'web-pdb-')), 'web', 'projects.sqlite')
    const db = openProjectsDb(path)
    expect((db.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
    const created = new ProjectStore(db).create(input)
    db.close()
    const again = openProjectsDb(path)
    expect((again.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1)
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
