import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sanitizePath } from '../utils/sessionStoragePortable.js'
import { resolveAllowedFile, transcriptFileScope } from './files.js'

const ID = '11111111-2222-4333-8444-555555555555'
let root = ''
let prior: string | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'web-files-')))
  prior = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'home', '.claude')
})

afterEach(() => {
  if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prior
  rmSync(root, { recursive: true, force: true })
})

describe('resolveAllowedFile', () => {
  it('serves web uploads and temporary chats but not the cookie key or other credentials', async () => {
    const home = join(root, 'home')
    const configDir = join(home, '.claude')
    for (const dir of ['web/uploads/s1', 'web/temp/chat-1']) mkdirSync(join(configDir, dir), { recursive: true })
    const files = {
      upload: join(configDir, 'web/uploads/s1/a.txt'),
      temp: join(configDir, 'web/temp/chat-1/b.txt'),
      cookieKey: join(configDir, 'web/server.json'),
      globalConfig: join(home, '.claude.json'),
      backup: join(home, '.claude.json.backup'),
      netrc: join(home, '.netrc'),
      sshKey: join(home, 'id_ed25519'),
      plain: join(home, 'notes.txt'),
    }
    for (const path of Object.values(files)) writeFileSync(path, 'x')
    const scope = { roots: [home], files: [], configDir }
    const allowed = Object.fromEntries(
      await Promise.all(Object.entries(files).map(async ([k, path]) => [k, (await resolveAllowedFile(path, scope)) !== undefined])),
    )
    expect(allowed).toEqual({
      upload: true,
      temp: true,
      cookieKey: false,
      globalConfig: false,
      backup: false,
      netrc: false,
      sshKey: false,
      plain: true,
    })
  })
})

describe('transcriptFileScope', () => {
  it('lists only the files of tool calls that ran', async () => {
    const cwd = join(root, 'project')
    mkdirSync(cwd)
    const dir = join(root, 'home', '.claude', 'projects', sanitizePath(cwd))
    mkdirSync(dir, { recursive: true })
    let n = 0
    const entry = (type: string, content: unknown) => {
      const uuid = `a0000000-0000-4000-8000-00000000000${++n}`
      const parentUuid = n === 1 ? null : `a0000000-0000-4000-8000-00000000000${n - 1}`
      return JSON.stringify({ sessionId: ID, isSidechain: false, timestamp: '2026-11-12T00:00:00.000Z', type, uuid, parentUuid, cwd, message: { id: `m${n}`, role: type, content } })
    }
    const use = (id: string, path: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: path } })
    const result = (id: string, isError: boolean) => ({ type: 'tool_result', tool_use_id: id, content: 'r', ...(isError && { is_error: true }) })
    const lines = [
      entry('user', 'read them'),
      entry('assistant', [use('t1', '/outside/ran.txt'), use('t2', '/outside/refused.txt')]),
      entry('user', [result('t1', false), result('t2', true)]),
      entry('assistant', [use('t3', '/outside/pending.txt')]),
    ]
    writeFileSync(join(dir, `${ID}.jsonl`), lines.join('\n') + '\n')
    expect((await transcriptFileScope(ID)).files).toEqual(['/outside/ran.txt'])
  })
})
