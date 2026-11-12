import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId, setOriginalCwd } from '../bootstrap/state.js'
import { getProjectDir, getProjectsDir } from '../utils/sessionStorage.js'
import {
  buildMemoryIndex,
  findMemoryFilesForPrompt,
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

  test('keeps short words when the query also has long ones, ranking chunks with more words first', async () => {
    expect((await search('unrelatedword 中文')).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
    // Short Latin words and single characters next to long words would match nearly everything.
    expect(await search('unrelatedword a 的')).toEqual([])
    expect((await search('binary 中文 原文')).map(h => h.path)).toEqual([
      join(memDir, 'lang.md'),
      join(memDir, 'build.md'),
    ])
  })

  test('snippets show the matched word with its surrounding text', async () => {
    const path = join(memDir, 'long.md')
    writeFileSync(path, 'filler '.repeat(100) + 'the DB lock is per process')
    const [hit] = await search('DB')
    const [ftsHit] = await search('process')
    rmSync(path)
    expect(hit?.path).toBe(path)
    expect(hit?.snippet).toContain('[DB] lock')
    expect(ftsHit?.snippet).toContain('filler filler filler filler the DB lock is per [process]')
  })

  test('simplified and traditional Chinese find each other, snippets keep the original', async () => {
    const [hit] = await search('代码')
    expect(hit?.path).toBe(join(memDir, 'lang.md'))
    expect(hit?.snippet).toContain('[代碼]')
    const path = join(memDir, 'simplified.md')
    writeFileSync(path, '记忆系统使用 SQLite 索引')
    const hits = await search('記憶系統')
    rmSync(path)
    expect(hits.map(h => h.path)).toEqual([path])
    expect(hits[0]?.snippet).toContain('[记忆]系统')
  })

  test('splits Korean like Chinese, so particles and short words still match', async () => {
    const path = join(memDir, 'ko.md')
    writeFileSync(path, '배포 전에 검색 기능을 테스트한다')
    const results = [await search('unrelatedword 검색'), await search('검색을')]
    rmSync(path)
    for (const hits of results) expect(hits.map(h => h.path)).toEqual([path])
  })

  test('bounds the SQL for a very long query', async () => {
    // Thousands of distinct bigrams and trigrams once split.
    const long = '代碼保持原文' + Array.from({ length: 2000 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('')
    expect((await search(long)).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
    const found = await findMemoryFilesForPrompt({ prompt: long, scopes: ['project'], exclude: new Set(), limit: 3 })
    expect(found.map(h => h.path)).toEqual([join(memDir, 'lang.md')])
  })

  test('ignores accents and gives the match offset in the snippet', async () => {
    const path = join(memDir, 'accent.md')
    writeFileSync(path, '- [link](x.md) Meet at the ÉCOLE café')
    const results = [await search('ecole'), await search('Café'), await search('unrelatedword cafe')]
    rmSync(path)
    for (const [hit] of results) expect(hit?.path).toBe(path)
    const [hit] = results[0]!
    expect(hit?.snippet).toBe('- [link](x.md) Meet at the [ÉCOLE] café')
    expect(hit?.snippet.slice(...hit!.match!)).toBe('[ÉCOLE]')
  })

  test('matches Chinese queries written without spaces by their trigrams', async () => {
    expect((await search('回覆要使用中文嗎')).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
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

  test('a symlink back into the memory directory neither loops nor drops its memories', async () => {
    expect((await search('package')).map(h => h.path)).toEqual([join(memDir, 'build.md')])
    // Two links back used to make Bun's recursive readdir grow until it ran out of memory.
    symlinkSync(memDir, join(memDir, 'loop'))
    symlinkSync('..', join(memDir, 'team-loop'))
    try {
      expect((await search('package')).map(h => h.path)).toEqual([join(memDir, 'build.md')])
    } finally {
      rmSync(join(memDir, 'loop'))
      rmSync(join(memDir, 'team-loop'))
    }
  })

  test('treats FTS5 syntax in queries as literal text', async () => {
    expect(await search('"NEAR( OR *')).toEqual([])
  })

  test('control characters in a query separate words instead of failing the search', async () => {
    expect((await search('package\u0000binary')).map(h => h.path)).toEqual([join(memDir, 'build.md')])
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

  test('concurrent searches index appended lines once', async () => {
    const file = join(projectDir, 'session-c.jsonl')
    writeFileSync(file, line('user', 'first narwhal'))
    await search('narwhal')
    appendFileSync(file, line('assistant', 'second narwhal'))
    await Promise.all([search('narwhal'), search('narwhal'), search('narwhal')])
    expect((await search('narwhal')).map(h => h.line).sort()).toEqual([1, 2])
  })

  test('concurrent searches index a new file once', async () => {
    writeFileSync(join(memDir, 'manatee.md'), 'The manatee note.')
    writeFileSync(join(projectDir, 'session-m.jsonl'), line('user', 'a manatee question'))
    await Promise.all([search('manatee'), search('manatee'), search('manatee')])
    expect((await search('manatee')).map(h => h.path).sort()).toEqual(
      [join(memDir, 'manatee.md'), join(projectDir, 'session-m.jsonl')].sort(),
    )
    rmSync(join(memDir, 'manatee.md'))
    rmSync(join(projectDir, 'session-m.jsonl'))
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

  test('an index a search filled counts as built', async () => {
    resetMemoryIndexForTesting(':memory:')
    await search('walrus')
    const status = getMemoryIndexStatus()
    expect(status.files).toBeGreaterThan(0)
    expect(status.built).toBe(true)
    expect(status.builtAt).toBeUndefined()
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

  test('finds memory files for a prompt by its distinctive words only', async () => {
    writeFileSync(join(memDir, 'MEMORY.md'), '- [build](build.md): how to build the binary')
    const find = (prompt: string) =>
      findMemoryFilesForPrompt({ prompt, scopes: ['project', 'user', 'session'], exclude: new Set(), limit: 3 })
    expect((await find('How should I build the binary for this project?')).map(h => h.path)).toEqual([
      join(memDir, 'build.md'),
    ])
    expect(await find('What does this project do?')).toEqual([])
    expect((await find('我應該使用中文回覆嗎？')).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
    // Two-character Chinese words, alone or inside a sentence, recall too.
    expect((await find('原文 代碼')).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
    expect((await find('原文和代碼怎麼辦')).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
    expect((await find('代码要保持原文吗')).map(h => h.path)).toEqual([join(memDir, 'lang.md')])
    rmSync(join(memDir, 'MEMORY.md'))
  })

  test('recall and search put newer days first among equally matching memory files', async () => {
    const days = ['2024-01-05', '2025-06-01', '2024-09-09']
    const versions = days.map((day, i) => {
      const path = join(memDir, `oncall-${i}.md`)
      writeFileSync(path, `On-call for ledger-sync rotated; page @alias-${i} from now on.`)
      utimesSync(path, new Date(day), new Date(day))
      return path
    })
    const recalled = await findMemoryFilesForPrompt({
      prompt: 'who is on-call for ledger-sync',
      scopes: ['project'],
      exclude: new Set(),
      limit: 3,
    })
    const hits = await search('ledger-sync on-call')
    versions.forEach(path => rmSync(path))
    const newestFirst = [versions[1], versions[2], versions[0]]
    expect(recalled.map(h => h.path)).toEqual(newestFirst)
    expect(hits.map(h => h.path)).toEqual(newestFirst)
    expect(hits.map(h => h.modified)).toEqual(['2025-06-01', '2024-09-09', '2024-01-05'])
  })

  test('recalls nothing for words that only match inside other words or in most memory files', async () => {
    const notes = Array.from({ length: 6 }, (_, i) => join(memDir, `note-${i}.md`))
    notes.forEach((path, i) => writeFileSync(path, `Raise the runtime timeout for gateway step ${i}.`))
    const find = (prompt: string) =>
      findMemoryFilesForPrompt({ prompt, scopes: ['project'], exclude: new Set(), limit: 5 })
    const results = [await find('what time is it now'), await find('the gateway is slow'), await find('gateway binary')]
    notes.forEach(path => rmSync(path))
    expect(results[0]).toEqual([])
    expect(results[1]).toEqual([])
    expect(results[2]!.map(h => h.path)).toEqual([join(memDir, 'build.md')])
  })

  test('replaces an index file that is not a database instead of failing every search', async () => {
    const path = join(root, 'damaged.sqlite')
    writeFileSync(path, Buffer.alloc(8192, 0x5a))
    resetMemoryIndexForTesting(path)
    try {
      expect((await search('package')).map(h => h.path)).toEqual([join(memDir, 'build.md')])
    } finally {
      resetMemoryIndexForTesting(':memory:')
    }
  })
})
