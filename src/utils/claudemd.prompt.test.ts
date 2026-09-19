import { describe, expect, mock, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('CLAUDE.md prompt boundary', () => {
  test('scopes project instructions below mode and runtime enforcement', () => {
    const source = readFileSync(
      new URL('./claudemd.ts', import.meta.url),
      'utf8',
    )

    expect(source).toContain('override default task behavior')
    expect(source).toContain('do not override active permission modes')
    expect(source).toContain('runtime safety enforcement')
    expect(source).not.toContain('OVERRIDE any default behavior')
  })
})

const childFlag = 'CLAUDE_CODE_INSTRUCTION_DISCOVERY_TEST_CHILD'

if (!process.env[childFlag]) {
  test('discovers AGENTS.md alongside CLAUDE.md using isolated settings', async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'instruction-discovery-')),
    )
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
          DISABLE_AUTOUPDATER: '1',
          [childFlag]: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 30000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  const root = process.env.HOME!
  // Keep the managed policy boundary inside the fixture as well.
  mock.module('./settings/managedPath.js', () => ({
    getManagedFilePath: () => join(root, 'managed'),
    getManagedSettingsDropInDir: () =>
      join(root, 'managed', 'managed-settings.d'),
  }))

  test('loads both project filenames from parents to cwd in stable order', async () => {
    const parent = join(root, 'workspace')
    const project = join(parent, 'project')
    mkdirSync(project, { recursive: true })
    for (const [dir, label] of [
      [parent, 'parent'],
      [project, 'project'],
    ]) {
      writeFileSync(join(dir!, 'AGENTS.md'), `${label} agents instructions`)
      writeFileSync(join(dir!, 'CLAUDE.md'), `${label} claude instructions`)
    }
    const { setOriginalCwd, setAllowedSettingSources } =
      await import('../bootstrap/state.js')
    setOriginalCwd(project)
    setAllowedSettingSources(['projectSettings', 'localSettings'])
    const { getMemoryFiles, getClaudeMds } = await import('./claudemd.js')
    const files = await getMemoryFiles()
    expect(files.map(file => file.path)).toEqual([
      join(parent, 'AGENTS.md'),
      join(parent, 'CLAUDE.md'),
      join(project, 'AGENTS.md'),
      join(project, 'CLAUDE.md'),
    ])
    expect(files.every(file => file.type === 'Project')).toBe(true)
    const prompt = getClaudeMds(files)
    expect(prompt).toContain('parent agents instructions')
    expect(prompt).toContain('project claude instructions')
  })

  test('loads nested AGENTS.md on demand alongside existing rules without duplicates', async () => {
    const project = join(root, 'nested-project')
    const nested = join(project, 'src')
    mkdirSync(join(nested, '.claude', 'rules'), { recursive: true })
    writeFileSync(join(nested, 'AGENTS.md'), 'nested agents instructions')
    writeFileSync(join(nested, 'CLAUDE.md'), 'nested claude instructions')
    writeFileSync(
      join(nested, 'CLAUDE.local.md'),
      'private nested instructions',
    )
    writeFileSync(join(nested, '.claude', 'rules', 'general.md'), 'nested rule')
    const { setOriginalCwd, setAllowedSettingSources } =
      await import('../bootstrap/state.js')
    setOriginalCwd(project)
    setAllowedSettingSources(['projectSettings', 'localSettings'])
    const {
      clearMemoryFileCaches,
      getMemoryFiles,
      getMemoryFilesForNestedDirectory,
    } = await import('./claudemd.js')
    clearMemoryFileCaches()
    expect(await getMemoryFiles()).toEqual([])
    const processed = new Set<string>()
    const files = await getMemoryFilesForNestedDirectory(
      nested,
      join(nested, 'index.ts'),
      processed,
    )
    expect(files.map(file => file.path)).toEqual([
      join(nested, 'AGENTS.md'),
      join(nested, 'CLAUDE.md'),
      join(nested, 'CLAUDE.local.md'),
      join(nested, '.claude', 'rules', 'general.md'),
    ])
    expect(
      await getMemoryFilesForNestedDirectory(
        nested,
        join(nested, 'other.ts'),
        processed,
      ),
    ).toEqual([])
  })

  test('loads AGENTS.md from additional directories only when enabled', async () => {
    const project = join(root, 'add-dir-project')
    const additional = join(root, 'additional')
    mkdirSync(project)
    mkdirSync(additional)
    writeFileSync(
      join(additional, 'AGENTS.md'),
      'additional agents instructions',
    )
    writeFileSync(
      join(additional, 'CLAUDE.md'),
      'additional claude instructions',
    )
    const { setOriginalCwd, setAdditionalDirectoriesForClaudeMd } =
      await import('../bootstrap/state.js')
    const { clearMemoryFileCaches, getMemoryFiles } =
      await import('./claudemd.js')
    setOriginalCwd(project)
    setAdditionalDirectoriesForClaudeMd([additional])
    try {
      clearMemoryFileCaches()
      expect(await getMemoryFiles()).toEqual([])
      process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1'
      clearMemoryFileCaches()
      expect((await getMemoryFiles()).map(file => file.path)).toEqual([
        join(additional, 'AGENTS.md'),
        join(additional, 'CLAUDE.md'),
      ])
    } finally {
      delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
      setAdditionalDirectoriesForClaudeMd([])
      clearMemoryFileCaches()
    }
  })

  test('recognizes previously read nested AGENTS.md as an instruction file', async () => {
    const { getAllMemoryFilePaths, isMemoryFilePath } =
      await import('./claudemd.js')
    const { createFileStateCacheWithSizeLimit } =
      await import('./fileStateCache.js')
    const path = join(root, 'project', 'src', 'AGENTS.md')
    const cache = createFileStateCacheWithSizeLimit(10)
    cache.set(path, {
      content: 'nested instructions',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    expect(isMemoryFilePath(path)).toBe(true)
    expect(isMemoryFilePath(join(root, 'README.md'))).toBe(false)
    expect(getAllMemoryFilePaths([], cache)).toEqual([path])
  })

  test('shares include deduplication and external approval boundaries across both files', async () => {
    const project = join(root, 'includes-project')
    mkdirSync(project)
    const shared = join(project, 'shared.md')
    const external = join(root, 'external.md')
    writeFileSync(shared, 'shared instructions')
    writeFileSync(external, 'external instructions')
    writeFileSync(
      join(project, 'AGENTS.md'),
      'agents instructions\n@./shared.md\n@../external.md',
    )
    writeFileSync(
      join(project, 'CLAUDE.md'),
      'claude instructions\n@./shared.md\n@./AGENTS.md',
    )
    const { setOriginalCwd } = await import('../bootstrap/state.js')
    const {
      clearMemoryFileCaches,
      getExternalClaudeMdIncludes,
      getMemoryFiles,
    } = await import('./claudemd.js')
    setOriginalCwd(project)
    clearMemoryFileCaches()
    const files = await getMemoryFiles()
    expect(files.map(file => file.path)).toEqual([
      join(project, 'AGENTS.md'),
      shared,
      join(project, 'CLAUDE.md'),
    ])
    expect(getExternalClaudeMdIncludes(files)).toEqual([])
    expect(getExternalClaudeMdIncludes(await getMemoryFiles(true))).toEqual([
      { path: external, parent: join(project, 'AGENTS.md') },
    ])
  })

  test.each(['AGENTS.md', 'CLAUDE.md'])(
    'deduplicates a symlink to %s',
    async target => {
      const project = join(root, `symlink-${target}`)
      mkdirSync(project)
      writeFileSync(join(project, target), 'shared file instructions')
      symlinkSync(
        target,
        join(project, target === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md'),
      )
      const { setOriginalCwd } = await import('../bootstrap/state.js')
      const { clearMemoryFileCaches, getMemoryFiles } =
        await import('./claudemd.js')
      setOriginalCwd(project)
      clearMemoryFileCaches()
      const files = await getMemoryFiles()
      expect(files.map(file => file.content)).toEqual([
        'shared file instructions',
      ])
    },
  )

  test('loads a normalized path once even when realpath removes a redundant segment', async () => {
    const project = join(root, 'normalized-project')
    mkdirSync(project)
    writeFileSync(join(project, 'AGENTS.md'), 'normalized instructions')
    const { processMemoryFile } = await import('./claudemd.js')
    const processed = new Set<string>()
    const files = await processMemoryFile(
      `${project}/./AGENTS.md`,
      'Project',
      processed,
      false,
    )
    expect(files.map(file => file.content)).toEqual(['normalized instructions'])
    expect(
      await processMemoryFile(
        join(project, 'AGENTS.md'),
        'Project',
        processed,
        false,
      ),
    ).toEqual([])
  })

  test('applies project setting-source and exclusion controls to AGENTS.md', async () => {
    const project = join(root, 'controlled-project')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, 'AGENTS.md'), 'agents instructions')
    writeFileSync(join(project, 'CLAUDE.md'), 'claude instructions')
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        claudeMdExcludes: ['**/AGENTS.md'],
      }),
    )
    const { setOriginalCwd, setAllowedSettingSources } =
      await import('../bootstrap/state.js')
    const { resetSettingsCache } = await import('./settings/settingsCache.js')
    const {
      clearMemoryFileCaches,
      getMemoryFiles,
      getMemoryFilesForNestedDirectory,
    } = await import('./claudemd.js')
    setOriginalCwd(project)
    resetSettingsCache()
    clearMemoryFileCaches()
    expect((await getMemoryFiles()).map(file => file.path)).toEqual([
      join(project, 'CLAUDE.md'),
    ])
    expect(
      (
        await getMemoryFilesForNestedDirectory(
          project,
          join(project, 'index.ts'),
          new Set(),
        )
      ).map(file => file.path),
    ).toEqual([join(project, 'CLAUDE.md')])
    setAllowedSettingSources([])
    resetSettingsCache()
    clearMemoryFileCaches()
    try {
      expect(await getMemoryFiles()).toEqual([])
      expect(
        await getMemoryFilesForNestedDirectory(
          project,
          join(project, 'index.ts'),
          new Set(),
        ),
      ).toEqual([])
    } finally {
      setAllowedSettingSources(['projectSettings', 'localSettings'])
      resetSettingsCache()
      clearMemoryFileCaches()
    }
  })
}
