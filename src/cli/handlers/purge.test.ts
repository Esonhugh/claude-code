import { afterAll, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'purge-test-'))
const previousConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
const config = process.env.CLAUDE_CONFIG_DIR

const { getProjectDir } = await import('../../utils/sessionStoragePortable.js')
const { getGlobalConfig, saveGlobalConfig } = await import('../../utils/config.js')
const { resetMemoryIndexForTesting, defaultIndexPath } = await import('../../memdir/memoryIndex.js')
const { purgeProjectHandler } = await import('./purge.js')

afterAll(() => {
  resetMemoryIndexForTesting()
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  rmSync(root, { recursive: true, force: true })
})

function seed(project: string, session: string) {
  const dir = getProjectDir(project)
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, `${session}.jsonl`), '{}\n')
  writeFileSync(join(dir, 'memory', 'MEMORY.md'), 'note\n')
  mkdirSync(join(config, 'tasks', session), { recursive: true })
  mkdirSync(join(config, 'file-history', session), { recursive: true })
  mkdirSync(join(config, 'debug'), { recursive: true })
  writeFileSync(join(config, 'debug', `${session}.txt`), 'log\n')
  return dir
}

async function run(path: string | undefined, options: Parameters<typeof purgeProjectHandler>[1]) {
  const out: string[] = []
  const err: string[] = []
  const stdout = spyOn(process.stdout, 'write').mockImplementation(chunk => (out.push(String(chunk)), true))
  const stderr = spyOn(process.stderr, 'write').mockImplementation(chunk => (err.push(String(chunk)), true))
  const exit = spyOn(process, 'exit').mockImplementation(code => {
    throw new Error(`exit ${code}`)
  })
  let code: string
  try {
    await purgeProjectHandler(path, options)
    code = 'returned'
  } catch (error) {
    code = (error as Error).message
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
    exit.mockRestore()
  }
  return { code, out: out.join(''), err: err.join('') }
}

test('purge removes one project and its memory index rows, like 2.1.311 plus the SQLite index', async () => {
  const project = join(root, 'work', 'proj')
  const other = join(root, 'work', 'other')
  mkdirSync(project, { recursive: true })
  mkdirSync(other, { recursive: true })
  const projectDir = seed(project, 'aaaa-1111')
  const otherDir = seed(other, 'bbbb-2222')
  writeFileSync(
    join(config, 'history.jsonl'),
    [project, join(project, 'sub'), other].map(p => JSON.stringify({ display: 'x', project: p })).join('\n') + '\n',
  )
  saveGlobalConfig(c => ({ ...c, projects: { ...c.projects, [project]: {} as never, [other]: {} as never } }))
  const index = new Database(defaultIndexPath(), { create: true })
  index.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  index.run("INSERT INTO meta VALUES ('schema_version', '1')")
  index.run('CREATE TABLE files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER, lines INTEGER)')
  index.run("CREATE VIRTUAL TABLE chunks USING fts5(body, path UNINDEXED, kind UNINDEXED, project UNINDEXED, line UNINDEXED, tokenize = 'trigram')")
  for (const dir of [projectDir, otherDir]) {
    const file = join(dir, 'memory', 'MEMORY.md')
    index.run('INSERT INTO files VALUES (?, 0, 0, 1)', [file])
    index.run("INSERT INTO chunks VALUES ('note', ?, 'memory', ?, 1)", [file, dir.split('/').pop()!])
  }
  index.close()
  resetMemoryIndexForTesting()

  const dry = await run(project, { dryRun: true })
  expect(dry.code).toBe('exit 0')
  expect(dry.out).toContain(`Purge plan for ${project}:`)
  expect(dry.out).toContain('tasks for session aaaa-1111')
  expect(dry.out).toContain('debug log for session aaaa-1111')
  expect(dry.out).toContain('file edit history for session aaaa-1111')
  expect(dry.out).toContain('project transcripts (.jsonl) and memory/')
  expect(dry.out).toContain('2 memory search index row(s) for this project')
  expect(dry.out).toContain(`config: projects["${project}"]`)
  expect(dry.out).toContain('2 prompt(s) typed in this project')
  expect(dry.out).toContain('Dry run: 7 item(s) would be deleted.')
  expect(existsSync(projectDir)).toBe(true)

  const done = await run(project, { yes: true })
  expect(done.code).toBe('exit 0')
  expect(done.out).toContain(`Purged 7 item(s) for ${project}.`)
  expect(existsSync(projectDir)).toBe(false)
  expect(existsSync(join(config, 'tasks', 'aaaa-1111'))).toBe(false)
  expect(existsSync(join(config, 'debug', 'aaaa-1111.txt'))).toBe(false)
  expect(existsSync(join(config, 'file-history', 'aaaa-1111'))).toBe(false)
  expect(existsSync(otherDir)).toBe(true)
  expect(existsSync(join(config, 'tasks', 'bbbb-2222'))).toBe(true)
  expect(Object.keys(getGlobalConfig().projects ?? {})).not.toContain(project)
  expect(Object.keys(getGlobalConfig().projects ?? {})).toContain(other)
  expect(readFileSync(join(config, 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).project)).toEqual([other])
  resetMemoryIndexForTesting()
  const after = new Database(defaultIndexPath())
  expect((after.query('SELECT path FROM files').all() as { path: string }[]).map(r => r.path)).toEqual([join(otherDir, 'memory', 'MEMORY.md')])
  expect((after.query('SELECT count(*) AS n FROM chunks').get() as { n: number }).n).toBe(1)
  after.close()

  const again = await run(project, { yes: true })
  expect(again.code).toBe('exit 1')
  expect(again.err).toContain(`No Claude Code project state found for ${project} under ${config}.`)
})

test('purge rejects a path with --all, and -i with --all', async () => {
  expect((await run('x', { all: true })).err).toContain('Cannot specify both a path and --all.')
  expect((await run(undefined, { all: true, interactive: true })).err).toContain('Cannot use -i/--interactive with --all.')
})
