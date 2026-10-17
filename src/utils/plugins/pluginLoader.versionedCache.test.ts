import { expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Plugin directories are resolved from process env, so the cases run in a
// fresh child whose HOME and config dir are owned by this test.
if (!process.env.PL4_VERSIONED_CACHE_TEST_CHILD) {
  test('versioned cache publishes complete directories only', async () => {
    const home = realpathSync(
      mkdtempSync(join(tmpdir(), 'pl4-versioned-cache-')),
    )
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: join(home, 'config'),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        PL4_VERSIONED_CACHE_TEST_CHILD: '1',
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
    expect(stderr).toMatch(/(?:^|\n) 4 pass(?:\n|$)/)
    expect(code).toBe(0)
  }, 30000)
} else {
  const root = process.env.HOME!
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const loader = await import('./pluginLoader.js')
  const cacheUtils = await import('./cacheUtils.js')

  const SKILLS = 40
  const source = join(root, 'big')
  mkdirSync(join(source, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(source, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'big', version: '3.0.0' }),
  )
  const skill = (i: number) =>
    join(source, 'skills', `s${String(i).padStart(3, '0')}`)
  for (let i = 1; i <= SKILLS; i++) {
    mkdirSync(skill(i), { recursive: true })
    writeFileSync(join(skill(i), 'SKILL.md'), `skill ${i}`)
  }
  const copy = () =>
    loader.copyPluginToVersionedCache(source, 'big@lab', '3.0.0')
  const skillCount = (dir: string) => readdirSync(join(dir, 'skills')).length

  test('an interrupted copy is not reused as a complete version', async () => {
    const cachePath = loader.getVersionedCachePath('big@lab', '3.0.0')
    // Break the copy part-way through: the last skill cannot be read.
    const blocked = join(skill(SKILLS), 'SKILL.md')
    chmodSync(blocked, 0o000)
    await expect(copy()).rejects.toThrow()
    chmodSync(blocked, 0o644)

    expect(existsSync(cachePath)).toBe(false)
    expect(
      readdirSync(join(cachePath, '..')).filter(n => n.includes('.tmp.')),
    ).toEqual([])

    const path = await copy()
    expect(path).toBe(cachePath)
    expect(skillCount(path)).toBe(SKILLS)
  })

  test('an update rebuilds a legacy incomplete target instead of reusing it', async () => {
    const cachePath = loader.getVersionedCachePath('legacy@lab', '3.0.0')
    mkdirSync(join(cachePath, 'skills/s001'), { recursive: true })
    writeFileSync(join(cachePath, 'skills/s001/SKILL.md'), 'old partial')
    expect(skillCount(cachePath)).toBe(1)
    await loader.copyPluginToVersionedCache(
      source,
      'legacy@lab',
      '3.0.0',
      undefined,
      undefined,
      { replaceExisting: true },
    )
    expect(skillCount(cachePath)).toBe(SKILLS)
  })

  test('startup cleanup removes staging dirs of dead processes only', async () => {
    const cachePath = await copy()
    mkdirSync(join(root, 'config/plugins'), { recursive: true })
    writeFileSync(
      join(root, 'config/plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'big@lab': [
            {
              scope: 'user',
              installPath: cachePath,
              version: '3.0.0',
              installedAt: new Date().toISOString(),
              lastUpdated: new Date().toISOString(),
            },
          ],
        },
      }),
    )
    const exited = Bun.spawn(['true'])
    await exited.exited
    const uuid = '0f0f0f0f-0000-4000-8000-000000000000'
    const dead = `${cachePath}.tmp.${exited.pid}.${uuid}`
    const live = `${cachePath}.tmp.${process.pid}.${uuid}`
    const fresh = `${cachePath}.tmp.${exited.pid}.1f0f0f0f-0000-4000-8000-000000000000`
    for (const dir of [dead, live, fresh]) {
      mkdirSync(join(dir, 'skills'), { recursive: true })
    }

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    for (const dir of [dead, live]) utimesSync(dir, old, old)
    await cacheUtils.cleanupOrphanedPluginVersionsInBackground()

    expect(existsSync(dead)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(join(live, '.orphaned_at'))).toBe(false)
    expect(skillCount(cachePath)).toBe(SKILLS)
  })
  test('startup cleanup also sweeps stale staging without an installed registry', async () => {
    const file = join(root, 'config/plugins/installed_plugins.json')
    rmSync(file, { force: true })
    const dead = Bun.spawn(['true'])
    await dead.exited
    const staging =
      loader.getVersionedCachePath('empty@empty', '1.0.0') +
      `.tmp.${dead.pid}.2f0f0f0f-0000-4000-8000-000000000000`
    mkdirSync(staging, { recursive: true })
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(staging, old, old)
    await cacheUtils.cleanupOrphanedPluginVersionsInBackground()
    expect(existsSync(staging)).toBe(false)
  })
}
