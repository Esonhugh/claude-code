import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId, setOriginalCwd } from '../bootstrap/state.js'
import { getProjectDir, getProjectsDir } from '../utils/sessionStorage.js'
import {
  buildMemoryIndex,
  getMemoryIndexStatus,
  resetMemoryIndexForTesting,
  searchMemory,
  transcriptChunks,
} from './memoryIndex.js'
import { getAutoMemPath } from './paths.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-index-')))
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
const prevMemOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
let projectDir: string
let memDir: string
let otherDir: string

function line(type: string, content: unknown): string {
  return JSON.stringify({ type, message: { role: type, content } }) + '\n'
}

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  const cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  setOriginalCwd(cwd)
  projectDir = getProjectDir(cwd)
  // Never let fixtures land in a real memory directory set by the environment.
  process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = join(root, 'memory')
  getAutoMemPath.cache.clear?.()
  memDir = getAutoMemPath()
  otherDir = join(getProjectsDir(), '-other-project')
  mkdirSync(memDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(join(otherDir, 'memory'), { recursive: true })
  expect(memDir.startsWith(root)).toBe(true)
  writeFileSync(join(memDir, 'build.md'), '---\nname: build\n---\nAlways build with bun package:binary, never npm.')
  writeFileSync(join(memDir, 'lang.md'), '---\nname: lang\n---\n回覆使用中文，代碼保持原文。')
  writeFileSync(
    join(projectDir, 'session-a.jsonl'),
    line('user', 'Why does the gateway drop tool_reference blocks?') +
      line('assistant', [{ type: 'text', text: 'Because the beta header is missing.' }, { type: 'tool_use', name: 'Bash' }]) +
      '{"type":"summary","summary":"ignored"}\n',
  )
  writeFileSync(join(otherDir, 'memory', 'deploy.md'), 'Deploy through the staging gateway first.')
  resetMemoryIndexForTesting(':memory:')
})

afterAll(() => {
  resetMemoryIndexForTesting()
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  if (prevMemOverride === undefined) delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  else process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = prevMemOverride
  getAutoMemPath.cache.clear?.()
  rmSync(root, { recursive: true, force: true })
})

const search = (query: string, extra: Partial<Parameters<typeof searchMemory>[0]> = {}) =>
  searchMemory({ query, scopes: ['project', 'session'], limit: 10, ...extra })

describe('transcriptChunks', () => {
  test('keeps user and assistant text with line numbers', () => {
    const raw = line('user', 'hello there') + 'not json\n' + line('assistant', [{ type: 'text', text: 'hi' }])
    expect(transcriptChunks(raw)).toEqual([
      { line: 1, body: 'user: hello there' },
      { line: 3, body: 'assistant: hi' },
    ])
  })

  test('skips harness-injected meta messages', () => {
    const meta = JSON.stringify({ type: 'user', isMeta: true, message: { content: 'injected reminder' } })
    expect(transcriptChunks(meta + '\n')).toEqual([])
  })
})

describe('searchMemory', () => {
  test('finds memory files by English and Chinese text', async () => {
    const [hit] = await search('package binary')
    expect(hit?.path).toBe(join(memDir, 'build.md'))
    expect(hit?.kind).toBe('memory')
    expect((await search('使用中文')).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
  })

  test('finds transcript messages with their line', async () => {
    const hits = await search('beta header', { scopes: ['session'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: join(projectDir, 'session-a.jsonl'), kind: 'transcript', line: 2 })
    expect(await search('ignored', { scopes: ['session'] })).toEqual([])
  })

  test('ranks files that match any of the words', async () => {
    const hits = await search('package unrelatedword')
    expect(hits.map(h => h.path)).toEqual([join(memDir, 'build.md')])
  })

  test('falls back to substring match for short terms', async () => {
    expect((await search('中文')).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
  })

  test('user scope covers memories of other projects', async () => {
    expect(await search('staging')).toEqual([])
    const hits = await search('staging', { scopes: ['user'] })
    expect(hits.map(h => h.path)).toEqual([join(otherDir, 'memory', 'deploy.md')])
  })

  test('re-indexes changed files and forgets deleted ones', async () => {
    appendFileSync(join(projectDir, 'session-a.jsonl'), line('user', 'remember the flamingo protocol'))
    expect(await search('flamingo')).toHaveLength(1)
    rmSync(join(otherDir, 'memory', 'deploy.md'))
    expect(await search('staging', { scopes: ['user'] })).toEqual([])
  })

  test('treats FTS5 syntax in queries as literal text', async () => {
    expect(await search('"NEAR( OR *')).toEqual([])
  })

  test('skips the running session transcript', async () => {
    writeFileSync(join(projectDir, `${getSessionId()}.jsonl`), line('user', 'current pelican chatter'))
    expect(await search('pelican')).toEqual([])
  })

  test('indexes appended transcript lines with their line numbers', async () => {
    const file = join(projectDir, 'session-b.jsonl')
    writeFileSync(file, line('user', 'first walrus'))
    expect((await search('walrus')).map(h => h.line)).toEqual([1])
    // A half-written line waits until it is complete.
    appendFileSync(file, line('assistant', 'second walrus') + '{"type":"user","mess')
    expect((await search('walrus')).map(h => h.line).sort()).toEqual([1, 2])
    appendFileSync(file, 'age":{"content":"third walrus"}}\n')
    expect((await search('walrus')).map(h => h.line).sort()).toEqual([1, 2, 3])
  })

  test('indexes memory in subdirectories such as team memory', async () => {
    mkdirSync(join(memDir, 'team'), { recursive: true })
    writeFileSync(join(memDir, 'team', 'review.md'), 'Reviews need two approvals from the octopus team.')
    expect((await search('octopus')).map(h => h.path)).toEqual([join(memDir, 'team', 'review.md')])
  })

  test('build re-indexes from scratch, replacing stale rows', async () => {
    const file = join(memDir, 'stale.md')
    const mtime = new Date(1_700_000_000_000)
    writeFileSync(file, 'beaver')
    utimesSync(file, mtime, mtime)
    expect(await search('beaver')).toHaveLength(1)
    // Same size and mtime: an incremental refresh cannot see this change.
    writeFileSync(file, 'badger')
    utimesSync(file, mtime, mtime)
    expect(await search('badger')).toEqual([])
    await buildMemoryIndex(['project'])
    expect(await search('badger')).toHaveLength(1)
    expect(await search('beaver')).toEqual([])
    rmSync(file)
  })

  test('build drops rows outside the scopes and reports status', async () => {
    await search('walrus')
    const status = await buildMemoryIndex(['project'])
    expect(status.built).toBe(true)
    // Only build.md, lang.md and team/review.md remain; transcripts were dropped.
    expect(status.files).toBe(3)
    expect(await search('walrus', { scopes: ['project'] })).toEqual([])
    expect(getMemoryIndexStatus().chunks).toBe(status.chunks)
    resetMemoryIndexForTesting(':memory:')
  })
})
