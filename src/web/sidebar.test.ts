import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sanitizePath } from '../utils/sessionStoragePortable.js'
import { openProjectsDb, patchSessionMeta, ProjectStore, readFolders } from './projectsDb.js'
import { deleteTranscript, loadSidebar, sessionTitle } from './sidebar.js'

const id = (n: number) => `${String(n).repeat(8)}-2222-4333-8444-555555555555`
let root = ''
let prior: string | undefined
let db: Database

function transcript(cwd: string, sid: string, entries: Record<string, unknown>[], mtime: number) {
  const dir = join(root, 'config', 'projects', sanitizePath(cwd))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sid}.jsonl`)
  writeFileSync(file, entries.map(e => JSON.stringify({ sessionId: sid, cwd, ...e })).join('\n') + '\n')
  utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}

const user = (text: string) => ({ type: 'user', uuid: crypto.randomUUID(), message: { role: 'user', content: text } })

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'web-sidebar-')))
  prior = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  db = openProjectsDb(':memory:')
})

afterEach(() => {
  db.close()
  if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prior
  rmSync(root, { recursive: true, force: true })
})

describe('sessionTitle', () => {
  it('falls back from a rename to the title, the last message and the id', () => {
    expect(sessionTitle('x', { title: 'T', message: 'M' }, { title: 'R' })).toEqual({ title: 'R', label: 'title' })
    expect(sessionTitle('x', { title: 'T', message: 'M' }, { title: null })).toEqual({ title: 'T', label: 'title' })
    expect(sessionTitle('x', { message: 'M' })).toEqual({ title: 'M', label: 'message' })
    expect(sessionTitle('x', {})).toEqual({ title: 'x', label: 'id' })
  })
})

describe('loadSidebar', () => {
  it('lists titles with fallbacks, marks and folders by their last change', async () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    mkdirSync(a)
    mkdirSync(b)
    const edited = join(b, 'notes.md')
    writeFileSync(edited, 'x')
    transcript(a, id(1), [user('first'), { type: 'custom-title', customTitle: 'Named' }], 5_000_000)
    transcript(a, id(2), [user('only prompt'), user('last prompt'), { type: 'last-prompt', lastPrompt: 'last prompt' }], 4_000_000)
    transcript(a, id(3), [{ type: 'system', subtype: 'informational', uuid: crypto.randomUUID() }], 3_000_000)
    transcript(b, id(4), [
      user('edit it'),
      { type: 'assistant', uuid: crypto.randomUUID(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: edited, content: 'x' } }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/etc/hosts' } }] } },
    ], 1_000_000)
    // The file changed after the session: folder b is newer than folder a.
    utimesSync(edited, 9_000, 9_000)
    transcript(b, id(5), [{ ...user('side'), isSidechain: true }], 6_000_000)
    patchSessionMeta(db, id(2), { pinned: true, unread: true, title: 'Renamed' }, 7)
    patchSessionMeta(db, id(3), { archived: true }, 8)

    const data = await loadSidebar(db, 100)
    expect(data.more).toBe(false)
    expect(data.sessions.map(s => [s.id, s.title, s.label])).toEqual([
      [id(1), 'Named', 'title'],
      [id(2), 'Renamed', 'title'],
      [id(3), id(3), 'id'],
      [id(4), 'edit it', 'message'],
    ])
    expect(data.sessions[1]).toMatchObject({ pinnedAt: 7, unread: true, cwd: a })
    expect(data.sessions[2]).toMatchObject({ archived: true, cwd: a })
    expect(data.sessions[3]).toMatchObject({ files: 1, cwd: b })
    expect(data.folders).toEqual({ [a]: 5_000_000, [b]: 9_000_000 })
    expect(readFolders(db).get(b)).toBe(9_000_000)
  })

  it('shows the last message when there is no title', async () => {
    const a = join(root, 'a')
    transcript(a, id(1), [user('first'), user('second'), { type: 'last-prompt', lastPrompt: 'second' }], 1_000_000)
    const data = await loadSidebar(db, 10)
    expect(data.sessions[0]).toMatchObject({ title: 'second', label: 'message' })
  })

  it('leaves out project coordinators', async () => {
    const a = join(root, 'a')
    transcript(a, id(1), [user('task')], 2_000_000)
    transcript(a, id(2), [user('coordinate')], 1_000_000)
    const store = new ProjectStore(db)
    const project = store.create({ name: 'P', cwd: a, instructions: '', worker_model: null, permission_mode: 'default' })
    store.update(project.id, { coordinator_session_id: id(2) })
    const data = await loadSidebar(db, 10)
    expect(data.sessions.map(s => s.id)).toEqual([id(1)])
  })

  it('keeps pinned sessions past the limit and says there are more', async () => {
    const a = join(root, 'a')
    for (let n = 1; n <= 4; n++) transcript(a, id(n), [user(`s${n}`)], n * 1_000_000)
    patchSessionMeta(db, id(1), { pinned: true })
    const data = await loadSidebar(db, 2)
    expect(data.sessions.map(s => s.id)).toEqual([id(4), id(3), id(1)])
    expect(data.more).toBe(true)
  })
})

describe('deleteTranscript', () => {
  it('removes the transcript and its folder, and nothing outside the projects dir', async () => {
    const a = join(root, 'a')
    const file = transcript(a, id(1), [user('x')], 1_000_000)
    const side = join(file, '..', id(1), 'subagents')
    mkdirSync(side, { recursive: true })
    expect(await deleteTranscript(id(1))).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(side)).toBe(false)
    expect(await deleteTranscript(id(1))).toBe(false)

    // A transcript symlinked to a file elsewhere is refused.
    const outside = join(root, 'outside.jsonl')
    writeFileSync(outside, JSON.stringify(user('keep')) + '\n')
    const dir = join(root, 'config', 'projects', sanitizePath(a))
    symlinkSync(outside, join(dir, `${id(2)}.jsonl`))
    expect(await deleteTranscript(id(2))).toBe(false)
    expect(existsSync(outside)).toBe(true)
  })
})
