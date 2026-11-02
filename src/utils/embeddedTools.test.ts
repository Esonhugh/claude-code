import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The cache root is read when cachePaths loads, so point it at a temp dir first.
const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-search-cache-'))
const savedCacheHome = process.env.XDG_CACHE_HOME
process.env.XDG_CACHE_HOME = cacheHome
const { setSearchToolsOptIn } = await import('../bootstrap/state.js')
const { createFindGrepShellIntegration } = await import('./bash/ShellSnapshot.js')
const { hasEmbeddedSearchTools } = await import('./embeddedTools.js')
if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME
else process.env.XDG_CACHE_HOME = savedCacheHome

const ENV_KEYS = [
  'CLAUDE_CODE_EMBEDDED_BFS_PATH',
  'CLAUDE_CODE_EMBEDDED_UGREP_PATH',
  'CLAUDE_CODE_EMBEDDED_SEARCH_TOOLS_VERSION',
  'EMBEDDED_SEARCH_TOOLS',
  'CLAUDE_CODE_ENTRYPOINT',
] as const
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
let tempDir: string

// Fake bfs/ugrep that print the argv they were given.
function writeFakeTool(name: string): string {
  const file = path.join(tempDir, `source-${name}`)
  fs.writeFileSync(file, `#!/bin/sh\necho ${name} "$@"\n`)
  return file
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-search-tools-'))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.CLAUDE_CODE_EMBEDDED_BFS_PATH = writeFakeTool('bfs')
  process.env.CLAUDE_CODE_EMBEDDED_UGREP_PATH = writeFakeTool('ugrep')
  process.env.CLAUDE_CODE_EMBEDDED_SEARCH_TOOLS_VERSION = 'test'
  setSearchToolsOptIn(false)
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  setSearchToolsOptIn(false)
  fs.rmSync(tempDir, { recursive: true, force: true })
  fs.rmSync(cacheHome, { recursive: true, force: true })
})

test('embedded bfs/ugrep replace Glob/Grep unless opted out like official', () => {
  expect(hasEmbeddedSearchTools()).toBe(true)
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
  expect(hasEmbeddedSearchTools()).toBe(true)

  setSearchToolsOptIn(true)
  expect(hasEmbeddedSearchTools()).toBe(false)
  setSearchToolsOptIn(false)

  process.env.CLAUDE_CODE_ENTRYPOINT = 'local-agent'
  expect(hasEmbeddedSearchTools()).toBe(false)
  delete process.env.CLAUDE_CODE_ENTRYPOINT

  process.env.EMBEDDED_SEARCH_TOOLS = '0'
  expect(hasEmbeddedSearchTools()).toBe(false)
  delete process.env.EMBEDDED_SEARCH_TOOLS

  delete process.env.CLAUDE_CODE_EMBEDDED_UGREP_PATH
  expect(hasEmbeddedSearchTools()).toBe(false)
})

test.skipIf(process.platform === 'win32')(
  'find and grep run the extracted tools and fall back to the system command',
  () => {
    const integration = createFindGrepShellIntegration()
    expect(integration).not.toBeNull()
    const shell = (command: string) =>
      spawnSync('bash', ['-c', `${integration}\n${command}`], {
        cwd: tempDir,
        encoding: 'utf8',
      })

    expect(shell('find . -name x').stdout).toBe(
      'bfs -S dfs -regextype findutils-default . -name x\n',
    )
    expect(shell('grep -rn "a b" src').stdout).toBe(
      'ugrep -G --ignore-files --hidden -I --exclude-dir=.git --exclude-dir=.svn --exclude-dir=.hg --exclude-dir=.bzr --exclude-dir=.jj --exclude-dir=.sl -rn a b src\n',
    )

    // Options that run commands or read config go to the system grep.
    fs.writeFileSync(path.join(tempDir, 'file.txt'), 'needle\n')
    for (const unsafe of ['--filter=cat', '--pager=less', '--config', '-rZ']) {
      const result = shell(`grep ${unsafe} needle file.txt`)
      expect(result.stdout).not.toContain('ugrep')
    }
    expect(shell('grep -c needle file.txt').stdout).toContain('ugrep')

    // A removed extracted binary falls back too.
    const ugrepPath = integration!.match(/-x (\S+\/ugrep) /)![1]!
    fs.rmSync(ugrepPath)
    expect(shell('grep -c needle file.txt').stdout).toBe('1\n')
  },
)

test('paths inherited from a parent binary that this process cannot read do not count', () => {
  // A compiled parent exports its /$bunfs paths to every child process.
  process.env.CLAUDE_CODE_EMBEDDED_BFS_PATH = '/$bunfs/root/bfs-parent'
  process.env.CLAUDE_CODE_EMBEDDED_UGREP_PATH = '/$bunfs/root/ugrep-parent'
  expect(hasEmbeddedSearchTools()).toBe(false)
  expect(createFindGrepShellIntegration()).toBeNull()
})
