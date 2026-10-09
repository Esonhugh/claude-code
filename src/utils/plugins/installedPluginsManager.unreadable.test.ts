import { beforeEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The registry path comes from process env and the module caches its
// contents, so the cases run in a fresh child that owns HOME and config dir.
if (!process.env.PL5_UNREADABLE_TEST_CHILD) {
  test('an unreadable installed_plugins.json is kept before it is rebuilt', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pl5-unreadable-')))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        PL5_UNREADABLE_TEST_CHILD: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    console.log(stdout, stderr)
    expect(stderr).toMatch(/(?:^|\n) 21 pass(?:\n|$)/)
    expect(code).toBe(0)
  }, 30000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const installed = await import('./installedPluginsManager.js')
  const { getFsImplementation } = await import('../fsOperations.js')
  const pluginsDir = join(root, 'config/plugins')
  const registry = join(pluginsDir, 'installed_plugins.json')
  const truncated =
    '{\n  "version": 2,\n  "plugins": {\n    "good@evil": [\n      {'
  const keptName = `installed_plugins.unreadable.${new Date().toISOString().slice(0, 10)}.${createHash('sha256').update(truncated).digest('hex').slice(0, 12)}.kept`
  const record = (id: string) =>
    installed.addInstalledPlugin(
      id,
      {
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        installPath: join(pluginsDir, 'cache', id),
      },
      'user',
    )
  const reset = () => {
    rmSync(pluginsDir, { recursive: true, force: true })
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(registry, truncated)
    installed.clearInstalledPluginsCache()
    installed.resetMigrationState()
  }
  beforeEach(reset)

  const keptFiles = () =>
    readdirSync(pluginsDir).filter((n) => n.endsWith('.kept'))
  const valid = () => {
    writeFileSync(registry, JSON.stringify({ version: 2, plugins: {} }))
    installed.clearInstalledPluginsCache()
  }

  test('a write keeps the unreadable bytes before rebuilding and reports every copy', () => {
    record('a@b-c')
    const kept = join(pluginsDir, keptName)
    expect(readFileSync(kept, 'utf-8')).toBe(truncated)
    expect(getFsImplementation().statSync(kept).mode & 0o777).toBe(0o600)
    expect(
      Object.keys(JSON.parse(readFileSync(registry, 'utf-8')).plugins),
    ).toEqual(['a@b-c'])
    expect(installed.getUnreadableInstalledPluginsNote()).toBe(
      `Note: installed_plugins.json could not be read and was rebuilt. What it held is kept for a while in ${kept}. Plugins it listed may need installing again; look there for what was recorded.`,
    )
  })

  test('a session read never moves or rebuilds an unreadable registry', () => {
    // 官方 2.1.292 实测: plugin list / --json 纯读取不备份、不改原文件。
    expect(installed.loadInstalledPluginsV2().plugins).toEqual({})
    expect(installed.loadInstalledPluginsFromDisk().plugins).toEqual({})
    expect(readFileSync(registry, 'utf-8')).toBe(truncated)
    expect(keptFiles()).toEqual([])
  })

  test('the registry is not rebuilt when the kept copy cannot be written', () => {
    chmodSync(pluginsDir, 0o555)
    try {
      expect(() => record('a@b-c')).toThrow(
        `installed_plugins.json cannot be read, and it was not changed. Before it is rebuilt, its contents are kept in a file beside it, but that file (${join(pluginsDir, keptName)}) could not be written: `,
      )
    } finally {
      chmodSync(pluginsDir, 0o755)
    }
    expect(readFileSync(registry, 'utf-8')).toBe(truncated)
    expect(installed.getUnreadableInstalledPluginsNote()).toBeNull()
  })

  test('writes replace the file by rename instead of writing through it', () => {
    valid()
    record('good@evil')
    // A hard link sees in-place writes but not a rename over the path.
    const witness = join(root, 'witness.json')
    linkSync(registry, witness)
    const before = readFileSync(witness, 'utf-8')
    record('a@b-c')
    expect(readFileSync(witness, 'utf-8')).toBe(before)
    expect(
      Object.keys(JSON.parse(readFileSync(registry, 'utf-8')).plugins).sort(),
    ).toEqual(['a@b-c', 'good@evil'])
    expect(readdirSync(pluginsDir).filter((n) => n.includes('.tmp.'))).toEqual(
      [],
    )
    expect(existsSync(registry)).toBe(true)
  })

  test('the note includes all regular kept files in lexical order', () => {
    valid()
    const names = [
      'installed_plugins.unreadable.2026-10-02.aaaaaaaaaaaa.kept',
      'installed_plugins.unreadable.2026-10-01.bbbbbbbbbbbb.kept',
    ]
    for (const name of names) writeFileSync(join(pluginsDir, name), 'kept')
    mkdirSync(
      join(
        pluginsDir,
        'installed_plugins.unreadable.2026-10-03.cccccccccccc.kept',
      ),
    )
    symlinkSync(
      join(pluginsDir, names[0]!),
      join(
        pluginsDir,
        'installed_plugins.unreadable.2026-10-04.dddddddddddd.kept',
      ),
    )
    expect(installed.getUnreadableInstalledPluginsNote()).toBe(
      `Note: installed_plugins.json could not be read and was rebuilt. What it held is kept for a while in ${names
        .sort()
        .map((n) => join(pluginsDir, n))
        .join(
          ', ',
        )}. Plugins it listed may need installing again; look there for what was recorded.`,
    )
  })

  test('a failed keep can be retried without discarding a cached session snapshot', () => {
    const snapshot = installed.getInMemoryInstalledPlugins()
    chmodSync(pluginsDir, 0o555)
    try {
      expect(() => record('a@b-c')).toThrow(
        'installed_plugins.json cannot be read',
      )
    } finally {
      chmodSync(pluginsDir, 0o755)
    }
    record('a@b-c')
    expect(readFileSync(join(pluginsDir, keptName), 'utf-8')).toBe(truncated)
    expect(snapshot.plugins).toEqual({})
    expect(installed.getInMemoryInstalledPlugins()).toBe(snapshot)
  })

  test('newer registry formats are never silently overwritten', () => {
    const content = JSON.stringify({ version: 999, plugins: {} })
    writeFileSync(registry, content)
    expect(() => record('a@b-c')).toThrow(
      'installed_plugins.json was not changed: installed_plugins.json is in a format (version 999)',
    )
    expect(readFileSync(registry, 'utf-8')).toBe(content)
    expect(keptFiles()).toEqual([])
  })

  test('records under valid ids that this build cannot parse refuse writes', () => {
    const content = JSON.stringify({
      version: 2,
      plugins: { 'future@evil': [{ scope: 'future', installPath: '/future' }] },
    })
    writeFileSync(registry, content)
    expect(() => record('a@b-c')).toThrow(
      'holds a record under "future@evil" that this version of Claude Code cannot read',
    )
    expect(readFileSync(registry, 'utf-8')).toBe(content)
    expect(keptFiles()).toEqual([])
  })

  test('an unreadable hard-linked name is replaced without backing up another file', () => {
    // 官方 2.1.292 实测: nlink > 1 的坏记录不生成 .kept，替换名字不改其他名字。
    const witness = join(root, 'corrupt-linked.json')
    linkSync(registry, witness)
    record('a@b-c')
    expect(readFileSync(witness, 'utf-8')).toBe(truncated)
    expect(keptFiles()).toEqual([])
    expect(
      Object.keys(JSON.parse(readFileSync(registry, 'utf-8')).plugins),
    ).toEqual(['a@b-c'])
  })

  test('an unreadable symlink name is replaced while its target stays untouched', () => {
    const witness = join(root, 'corrupt-symlink-target.json')
    writeFileSync(witness, truncated)
    rmSync(registry)
    symlinkSync(witness, registry)
    record('a@b-c')
    expect(readFileSync(witness, 'utf-8')).toBe(truncated)
    expect(getFsImplementation().lstatSync(registry).isSymbolicLink()).toBe(
      false,
    )
    expect(keptFiles()).toEqual([])
  })

  test('read permission failure refuses replacement rather than treating it as corrupt JSON', () => {
    chmodSync(registry, 0)
    try {
      expect(() => record('a@b-c')).toThrow(
        'a file that cannot be read is not replaced',
      )
    } finally {
      chmodSync(registry, 0o600)
    }
    expect(readFileSync(registry, 'utf-8')).toBe(truncated)
    expect(keptFiles()).toEqual([])
  })

  test('failed final rename leaves the prior registry and cached snapshot unchanged', () => {
    valid()
    record('good@evil')
    const snapshot = installed.getInMemoryInstalledPlugins()
    const content = readFileSync(registry, 'utf-8')
    const fs = getFsImplementation(),
      rename = fs.renameSync
    const fault = Object.assign(new Error('publication fault'), { code: 'EIO' })
    const spy = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === registry) throw fault
      rename(from, to)
    })
    try {
      expect(() => record('a@b-c')).toThrow(fault)
    } finally {
      spy.mockRestore()
    }
    expect(readFileSync(registry, 'utf-8')).toBe(content)
    expect(installed.getInMemoryInstalledPlugins()).toBe(snapshot)
    expect(Object.keys(snapshot.plugins)).toEqual(['good@evil'])
    expect(readdirSync(pluginsDir).filter((n) => n.includes('.tmp.'))).toEqual(
      [],
    )
  })

  test('V1 migration replaces its file atomically without changing its hard-link witness', () => {
    const data = {
      version: 1,
      plugins: {
        'good@evil': {
          version: '1.0.0',
          installedAt: '2026-10-01T00:00:00.000Z',
          installPath: '/old',
        },
      },
    }
    writeFileSync(registry, JSON.stringify(data))
    const witness = join(root, 'migration-witness.json')
    linkSync(registry, witness)
    installed.migrateToSinglePluginFile()
    expect(JSON.parse(readFileSync(witness, 'utf-8'))).toEqual(data)
    expect(JSON.parse(readFileSync(registry, 'utf-8')).version).toBe(2)
    expect(keptFiles()).toEqual([])
  })

  test('legacy V2 consolidation keeps the unreadable main file before replacing it', () => {
    const legacy = installed.getInstalledPluginsV2FilePath()
    writeFileSync(
      legacy,
      JSON.stringify({
        version: 2,
        plugins: {
          'good@evil': [
            { scope: 'user', installPath: '/legacy', version: '1.0.0' },
          ],
        },
      }),
    )
    installed.migrateToSinglePluginFile()
    expect(readFileSync(join(pluginsDir, keptName), 'utf-8')).toBe(truncated)
    expect(
      Object.keys(JSON.parse(readFileSync(registry, 'utf-8')).plugins),
    ).toEqual(['good@evil'])
    expect(existsSync(legacy)).toBe(false)
  })

  test('background writes are atomic and retain the running session snapshot', () => {
    valid()
    record('good@evil')
    const snapshot = installed.getInMemoryInstalledPlugins()
    const witness = join(root, 'background-witness.json')
    linkSync(registry, witness)
    const before = readFileSync(witness, 'utf-8')
    installed.updateInstallationPathOnDisk(
      'good@evil',
      'user',
      undefined,
      '/new',
      '2.0.0',
    )
    expect(readFileSync(witness, 'utf-8')).toBe(before)
    expect(installed.getInMemoryInstalledPlugins()).toBe(snapshot)
    expect(snapshot.plugins['good@evil']![0]!.version).toBe('1.0.0')
    expect(
      installed.loadInstalledPluginsFromDisk().plugins['good@evil']![0]!
        .version,
    ).toBe('2.0.0')
  })

  test('the kept copy and hash preserve invalid UTF-8 bytes exactly', () => {
    const bytes = Buffer.from([123, 98, 97, 100, 255])
    writeFileSync(registry, bytes)
    record('a@b-c')
    const name = `installed_plugins.unreadable.${new Date().toISOString().slice(0, 10)}.${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.kept`
    expect(readFileSync(join(pluginsDir, name))).toEqual(bytes)
  })

  test('known records drop unknown fields as official 2.1.292 does', () => {
    valid()
    record('good@evil')
    const data = JSON.parse(readFileSync(registry, 'utf-8'))
    data.plugins['good@evil'][0].futureField = { preserve: 'raw' }
    writeFileSync(registry, JSON.stringify(data))
    record('a@b-c')
    // 官方 2.1.292 实测: unrelated install 会移除未声明的 futureField。
    expect(
      JSON.parse(readFileSync(registry, 'utf-8')).plugins['good@evil'][0]
        .futureField,
    ).toBeUndefined()
  })

  test('invalid id records are set aside without discarding usable records', () => {
    valid()
    record('good@evil')
    const data = JSON.parse(readFileSync(registry, 'utf-8'))
    data.plugins['not-an-id'] = { raw: 'original' }
    writeFileSync(registry, JSON.stringify(data))
    record('a@b-c')
    expect(
      Object.keys(JSON.parse(readFileSync(registry, 'utf-8')).plugins).sort(),
    ).toEqual(['a@b-c', 'good@evil'])
    const names = readdirSync(pluginsDir).filter((n) =>
      n.startsWith('installed_plugins.set-aside.'),
    )
    expect(names).toHaveLength(1)
    expect(
      JSON.parse(readFileSync(join(pluginsDir, names[0]!), 'utf-8')),
    ).toEqual({ 'not-an-id': { raw: 'original' } })
    expect(keptFiles()).toEqual([])
  })
  test('official installation metadata is retained and producer history is filtered', () => {
    valid()
    record('good@evil')
    const data = JSON.parse(readFileSync(registry, 'utf-8'))
    Object.assign(data.plugins['good@evil'][0], {
      resolvedVersion: '1.2.3',
      auto: true,
      claudeaiPluginId: 'plugin-id',
      archiveSha256: 'a'.repeat(64),
      directoryRepositoryKey: 'repository',
      sourceCommand: 'printf path',
      sourceProducerPath: 'C:\\plugin',
      previousProducerPaths: [
        ...Array.from({ length: 35 }, (_, i) => `/producer${i}`),
        'relative',
        5,
        'D:\\old',
      ],
      npmVersionSpec: '^1',
      npmResolved: 'package@1',
      npmIntegrity: 'sha512-test',
      npmRegistry: 'https://registry.npmjs.org',
    })
    writeFileSync(registry, JSON.stringify(data))
    record('a@b-c')
    const current = JSON.parse(readFileSync(registry, 'utf-8')).plugins[
      'good@evil'
    ][0]
    expect(current).toMatchObject({
      resolvedVersion: '1.2.3',
      auto: true,
      claudeaiPluginId: 'plugin-id',
      archiveSha256: 'a'.repeat(64),
      directoryRepositoryKey: 'repository',
      sourceCommand: 'printf path',
      sourceProducerPath: 'C:\\plugin',
      npmVersionSpec: '^1',
      npmResolved: 'package@1',
      npmIntegrity: 'sha512-test',
      npmRegistry: 'https://registry.npmjs.org',
    })
    expect(current.previousProducerPaths).toEqual([
      ...Array.from({ length: 31 }, (_, i) => `/producer${i + 4}`),
      'D:\\old',
    ])
  })

  test('malformed optional metadata is dropped without refusing usable records', () => {
    valid()
    record('good@evil')
    const data = JSON.parse(readFileSync(registry, 'utf-8'))
    Object.assign(data.plugins['good@evil'][0], {
      sourceCommand: 7,
      sourceProducerPath: 'relative',
      archiveSha256: 'invalid',
      previousProducerPaths: false,
      npmRegistry: 'file:///tmp/registry',
      claudeaiPluginId: 'x'.repeat(129),
    })
    writeFileSync(registry, JSON.stringify(data))
    record('a@b-c')
    const current = JSON.parse(readFileSync(registry, 'utf-8')).plugins[
      'good@evil'
    ][0]
    for (const key of [
      'sourceCommand',
      'sourceProducerPath',
      'archiveSha256',
      'previousProducerPaths',
      'npmRegistry',
      'claudeaiPluginId',
    ])
      expect(current[key]).toBeUndefined()
    expect(current.scope).toBe('user')
    expect(keptFiles()).toEqual([])
  })

  test('namespaced npm installation records remain readable instead of being set aside', () => {
    writeFileSync(
      registry,
      JSON.stringify({
        version: 2,
        plugins: {
          '@scope/package@npm': [
            { scope: 'user', installPath: '/npm-plugin', version: '1.0.0' },
          ],
        },
      }),
    )
    record('a@b-c')
    expect(
      Object.keys(JSON.parse(readFileSync(registry, 'utf-8')).plugins).sort(),
    ).toEqual(['@scope/package@npm', 'a@b-c'])
    expect(
      readdirSync(pluginsDir).filter((n) => n.includes('.set-aside.')),
    ).toEqual([])
  })
}
