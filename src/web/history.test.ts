import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sanitizePath } from '../utils/sessionStoragePortable.js'
import { listHistory, readTranscript, renameSession } from './history.js'

const ID = '11111111-2222-4333-8444-555555555555'
let root = ''
let prior: string | undefined

function line(entry: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: ID, isSidechain: false, timestamp: '2026-11-02T00:00:00.000Z', ...entry })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'web-history-')))
  prior = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  const cwd = join(root, 'project')
  mkdirSync(cwd)
  const dir = join(root, 'config', 'projects', sanitizePath(cwd))
  mkdirSync(dir, { recursive: true })
  const entries = [
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000001', parentUuid: null, cwd, message: { role: 'user', content: 'first question' } }),
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000002', parentUuid: 'a0000000-0000-4000-8000-000000000001', cwd, isMeta: true, message: { role: 'user', content: 'hidden meta' } }),
    line({
      type: 'assistant',
      uuid: 'a0000000-0000-4000-8000-000000000003',
      parentUuid: 'a0000000-0000-4000-8000-000000000002',
      cwd,
      message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'first answer' }] },
    }),
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000004', parentUuid: 'a0000000-0000-4000-8000-000000000003', cwd, message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
    line({ type: 'user', uuid: 'a0000000-0000-4000-8000-000000000005', parentUuid: 'a0000000-0000-4000-8000-000000000004', cwd, message: { role: 'user', content: [{ type: 'text', text: 'second question' }] } }),
  ]
  writeFileSync(join(dir, `${ID}.jsonl`), entries.join('\n') + '\n')
})

afterEach(() => {
  if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prior
  rmSync(root, { recursive: true, force: true })
})

describe('web history', () => {
  it('lists the session with its folder', async () => {
    const list = await listHistory(0, 10)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: ID, cwd: join(root, 'project') })
  })

  it('returns visible messages as stream-json and pages backwards', async () => {
    const page = await readTranscript(ID, undefined, 10)
    expect(page?.cwd).toBe(join(root, 'project'))
    expect(page?.total).toBe(3)
    expect(page?.messages.map(m => m.type)).toEqual(['user', 'assistant', 'user'])
    expect(page?.messages[0]).toMatchObject({ isReplay: true, parent_tool_use_id: null })
    expect(JSON.stringify(page?.messages)).not.toContain('hidden meta')
    expect(JSON.stringify(page?.messages)).not.toContain('command-name')

    const last = await readTranscript(ID, undefined, 1)
    expect(last).toMatchObject({ start: 2, total: 3 })
    const earlier = await readTranscript(ID, 2, 5)
    expect(earlier?.start).toBe(0)
    expect(earlier?.messages).toHaveLength(2)
  })

  it('renames by appending a custom title', async () => {
    expect(await renameSession(ID, 'My chat')).toBe(true)
    const file = join(root, 'config', 'projects', sanitizePath(join(root, 'project')), `${ID}.jsonl`)
    expect(readFileSync(file, 'utf8')).toContain('"customTitle":"My chat"')
    expect((await listHistory(0, 10))[0]?.title).toBe('My chat')
    expect(await renameSession('99999999-2222-4333-8444-555555555555', 'x')).toBe(false)
    expect(await readTranscript('99999999-2222-4333-8444-555555555555', undefined, 10)).toBeUndefined()
  })
})
