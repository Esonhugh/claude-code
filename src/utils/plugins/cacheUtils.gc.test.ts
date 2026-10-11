import { expect, test, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize, relative, sep } from 'node:path'

const cases = new Set([
  'producer-minimum', 'fresh-formats', 'temp-age-boundaries', 'temp-exact-grammar',
  'installed-prefix', 'normalized-installed', 'record-empty', 'record-missing',
  'record-corrupt', 'record-unreadable', 'marker-containment', 'installed-outside-marker',
  'version-age-boundaries', 'zip-and-symlink-container', 'marker-symlink',
  'version-symlink', 'directory-read-error', 'container-refill', 'ordinary-file-container', 'special-container',
])
const DAY = 86_400_000, HOUR = 3_600_000
const NOW = 1_791_158_400_000

// Keep filesystem module interception and Date/Math spies inside one fresh child.
// The parent shares no production imports or mocks with other Bun test files.
if (process.env.CLAUDE_CACHE_GC_TEST_CHILD !== '1') {
  for (const selected of cases) {
    test(`plugin cache GC: ${selected}`, async () => {
      const run = realpathSync(mkdtempSync(join(tmpdir(), 'cc-cache-gc-case-')))
      for (const name of ['home', 'config', 'tmp', 'transpile']) mkdirSync(join(run, name))
      console.log(`PLUGIN_CACHE_GC_OWNED_ROOT ${selected} ${run}`)
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: run,
        env: {
          PATH: process.env.PATH,
          HOME: join(run, 'home'),
          CLAUDE_CONFIG_DIR: join(run, 'config'),
          TMPDIR: join(run, 'tmp'),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(run, 'transpile'),
          NODE_ENV: 'test',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CACHE_GC_TEST_CHILD: '1',
          CLAUDE_CACHE_GC_TEST_CASE: selected,
        },
        stdout: 'pipe', stderr: 'pipe', timeout: 30000,
      })
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        console.log(stdout, stderr)
        expect(exitCode).toBe(0)
        expect(stdout).toContain(`PL1_A_CASE_SETTLED ${selected}`)
        expect(stderr).toMatch(/(?:^|\n) 1 pass(?:\n|$)/)
        expect(stderr).toMatch(/(?:^|\n) 0 fail(?:\n|$)/)
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL')
          await child.exited
        }
      }
      // Retain only this uniquely allocated run for failure/audit evidence.
      // Never scan or remove another test, user, or Claude process's directories.
    }, 35000)
  }
} else {
  const selected = process.env.CLAUDE_CACHE_GC_TEST_CASE
  if (!selected || !cases.has(selected)) throw new Error('Unknown plugin cache GC case')
  const { bootstrap, fault, interventions, observe, ownedRoot, real, record, setIntervention, tree, version } = await import('./cacheUtils.gc.fixture.js')
  const { FXe, KYn } = await import('./cacheUtils.gc.official.js')
test(`PL1 A ${selected}`, async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(NOW)
  const { loader, installed, gc, cache } = await bootstrap()
  const installedPath = installed.getInstalledPluginsFilePath()
  const live = join(cache, 'installed/live/1.0.0')
  await version(live, NOW, 20 * DAY)
  await record(installedPath, { 'live@installed': [{ installPath: live }] })
  const seed = async (name: string) => {
    const target = join(cache, name, 'plugin/1.0.0')
    await version(target, NOW, 20 * DAY)
    return { target, stage: join(cache, name) }
  }
  try {
    if (selected === 'producer-minimum') {
      const random = spyOn(Math, 'random').mockReturnValue(0)
      try {
        const actual = loader.generateTemporaryCacheNameForPlugin('./owned')
        const official = FXe('local')
        await observe(selected, { actual, official, actualMatchesOfficialGrammar: KYn.test(actual) })
        expect(official).toBe(`temp_local_${NOW}_0`)
        expect(actual).toBe(official)
        expect(KYn.test(actual)).toBe(true)
      } finally { random.mockRestore() }
    } else if (selected === 'fresh-formats') {
      const targets: string[] = []
      for (const source of ['local', 'npm', 'github', 'git', 'subdir', 'archive', 'command', 'unknown']) {
        for (const suffix of ['', '_x', '.clone']) {
          const name = FXe(source) + suffix
          expect(KYn.test(name)).toBe(true)
          const { stage } = await seed(name)
          targets.push(stage)
        }
      }
      const before = await Promise.all(targets.map(tree))
      await gc.cleanupOrphanedPluginVersionsInBackground()
      const after = await Promise.all(targets.map(tree))
      await observe(selected, { targets, before, after })
      expect(after).toEqual(before)
    } else if (selected === 'temp-age-boundaries') {
      const ages = [-6 * HOUR - 1, -6 * HOUR, -6 * HOUR + 1, 0, 14 * DAY - 1, 14 * DAY, 14 * DAY + 1]
      const rows = []
      for (const age of ages) {
        const name = `temp_local_${NOW - age}_a`
        expect(KYn.test(name)).toBe(true)
        const { target, stage } = await seed(name)
        rows.push({ age, stage, target, shouldRemain: age > -6 * HOUR && age < 14 * DAY, before: await tree(target) })
      }
      await gc.cleanupOrphanedPluginVersionsInBackground()
      const result = await Promise.all(rows.map(async row => ({ ...row, after: await tree(row.target) })))
      await observe(selected, result)
      for (const row of result) expect(row.after).toEqual(row.shouldRemain ? row.before : null)
    } else if (selected === 'temp-exact-grammar') {
      const names = [`temp_local_${NOW}_`, `temp_pip_${NOW}_a`, `temp_local_${NOW}_abcdefg`, `temp_local_${NOW}_a.extra`, `temp_local_${NOW}_A`, 'temp_local_short_a']
      const rows = []
      for (const name of names) {
        expect(KYn.test(name)).toBe(false)
        rows.push(await seed(name))
      }
      await gc.cleanupOrphanedPluginVersionsInBackground()
      const result = await Promise.all(rows.map(async row => ({ ...row, after: await tree(row.target) })))
      await observe(selected, result)
      for (const row of result) expect(row.after).toBe(null)
    } else if (selected === 'installed-prefix') {
      const { stage } = await seed(`temp_local_${NOW}_prefix`)
      const nestedLive = join(stage, 'recorded/1.0.0')
      await version(nestedLive, NOW, 20 * DAY)
      await record(installedPath, { 'live@installed': [{ installPath: live }], 'nested@recorded': [{ installPath: nestedLive }] })
      const before = await tree(nestedLive)
      await gc.cleanupOrphanedPluginVersionsInBackground()
      const nestedAfter = await tree(nestedLive), sibling = join(stage, 'plugin/1.0.0')
      await observe(selected, { stage, before, nestedAfter, orphanSibling: await tree(sibling), marker: await tree(join(nestedLive, '.orphaned_at')) })
      expect(await real.readFile(join(nestedLive, 'payload.txt'), 'utf8')).toBe('OWNED_VERSION:1.0.0')
      expect(await tree(join(nestedLive, '.orphaned_at'))).toBe(null)
      expect(await tree(sibling)).toBe(null)
    } else if (selected === 'normalized-installed') {
      const actual = join(cache, 'normal/plugin/1.0.0')
      await version(actual, NOW, 20 * DAY)
      const aliased = join(cache, 'normal/plugin') + `${sep}1.0.0${sep}..${sep}1.0.0`
      expect(normalize(aliased)).toBe(actual)
      await record(installedPath, { 'normal@normal': [{ installPath: aliased }] })
      await gc.cleanupOrphanedPluginVersionsInBackground()
      await observe(selected, { actual, aliased, after: await tree(actual), marker: await tree(join(actual, '.orphaned_at')) })
      expect(await real.readFile(join(actual, 'payload.txt'), 'utf8')).toBe('OWNED_VERSION:1.0.0')
      expect(await tree(join(actual, '.orphaned_at'))).toBe(null)
    } else if (selected.startsWith('record-')) {
      const target = join(cache, 'unreferenced/plugin/1.0.0')
      await version(target, NOW, 20 * DAY)
      if (selected === 'record-empty') await record(installedPath, {})
      if (selected === 'record-missing') await real.unlink(installedPath)
      if (selected === 'record-corrupt') await real.writeFile(installedPath, '{corrupt')
      if (selected === 'record-unreadable') {
        await real.unlink(installedPath)
        await real.mkdir(installedPath)
      }
      const before = await tree(target)
      let readerResult: unknown, strictReaderError: unknown
      try { readerResult = installed.loadInstalledPluginsFromDisk() } catch (error) { readerResult = String(error) }
      try { installed.readInstalledPluginsForContractValidation() } catch (error) { strictReaderError = String(error) }
      await gc.cleanupOrphanedPluginVersionsInBackground()
      await observe(selected, { installedPath, before, after: await tree(target), readerResult, strictReaderError })
      expect(await tree(target)).toEqual(before)
    } else if (selected === 'marker-containment') {
      const outside = join(ownedRoot, 'outside-marker-control')
      await real.mkdir(outside)
      await real.writeFile(join(outside, 'payload.txt'), 'OWNED_OUTSIDE')
      const target = join(cache, 'linked-marker-control')
      await real.symlink(outside, target, 'dir')
      const before = await tree(outside)
      await gc.markPluginVersionOrphaned(outside)
      await gc.markPluginVersionOrphaned(target)
      await observe(selected, { outside, target, before, after: await tree(outside) })
      expect(await tree(outside)).toEqual(before)
    } else if (selected === 'installed-outside-marker') {
      const outside = join(ownedRoot, 'outside-installed')
      await version(outside, NOW, 20 * DAY)
      await record(installedPath, { 'outside@outside': [{ installPath: outside }] })
      const before = await tree(outside)
      await gc.cleanupOrphanedPluginVersionsInBackground()
      await observe(selected, { outside, before, after: await tree(outside) })
      expect(await tree(outside)).toEqual(before)
    } else if (selected === 'version-age-boundaries') {
      const rows = []
      for (const age of [7 * DAY + 1, 14 * DAY - 1, 14 * DAY, 14 * DAY + 1]) {
        const path = join(cache, `age-${age}/plugin/1.0.0`)
        await version(path, NOW, age)
        rows.push({ age, path, before: await tree(path) })
      }
      await gc.cleanupOrphanedPluginVersionsInBackground()
      const result = await Promise.all(rows.map(async row => ({ ...row, after: await tree(row.path) })))
      await observe(selected, result)
      for (const row of result) expect(row.after).toEqual(row.age > 14 * DAY ? null : row.before)
    } else if (selected === 'zip-and-symlink-container') {
      const archive = join(cache, 'container/archived'), linked = join(cache, 'container/linked')
      const outside = join(ownedRoot, 'container-target')
      await real.mkdir(archive, { recursive: true }); await real.mkdir(linked, { recursive: true }); await real.mkdir(outside)
      await real.writeFile(join(archive, '1.0.0.ZiP'), Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))
      await real.writeFile(join(archive, 'ordinary-receipt.txt'), 'OWNED_RECEIPT')
      await real.writeFile(join(outside, 'target.txt'), 'OWNED_EXTERNAL_TARGET')
      await real.symlink(outside, join(linked, 'pointer'), 'dir')
      const before = await Promise.all([archive, linked, outside].map(tree))
      await gc.cleanupOrphanedPluginVersionsInBackground()
      const after = await Promise.all([archive, linked, outside].map(tree))
      await observe(selected, { before, after })
      expect(after).toEqual(before)
    } else if (selected === 'marker-symlink') {
      const target = join(cache, 'symlink-marker/plugin/1.0.0'), outside = join(ownedRoot, 'external-marker')
      await version(target, NOW, 20 * DAY)
      const marker = join(target, '.orphaned_at')
      await real.writeFile(outside, 'OWNED_EXTERNAL_MARKER')
      await real.utimes(outside, (NOW - 20 * DAY) / 1000, (NOW - 20 * DAY) / 1000)
      await real.unlink(marker); await real.symlink(outside, marker)
      await gc.cleanupOrphanedPluginVersionsInBackground()
      await observe(selected, { target: await tree(target), outside: await tree(outside), marker: await tree(marker) })
      expect(await real.readFile(join(target, 'payload.txt'), 'utf8')).toBe('OWNED_VERSION:1.0.0')
      expect((await real.lstat(marker)).isFile()).toBe(true)
      expect(await real.readFile(marker, 'utf8')).toBe(String(NOW))
      expect(await real.readFile(outside, 'utf8')).toBe('OWNED_EXTERNAL_MARKER')
    } else if (selected === 'version-symlink') {
      const parent = join(cache, 'symlink-version/plugin'), outside = join(ownedRoot, 'external-version')
      await real.mkdir(parent, { recursive: true }); await version(outside, NOW, 20 * DAY)
      await real.symlink(outside, join(parent, '1.0.0'), 'dir')
      const before = await tree(outside), linkBefore = await tree(parent)
      await gc.cleanupOrphanedPluginVersionsInBackground()
      await observe(selected, { outsideBefore: before, outsideAfter: await tree(outside), linkBefore, linkAfter: await tree(parent) })
      expect(await tree(outside)).toEqual(before)
      expect(await tree(parent)).toEqual(linkBefore)
    } else if (selected === 'directory-read-error') {
      const parent = join(cache, 'read-error/plugin'), target = join(parent, '1.0.0')
      await version(target, NOW, 20 * DAY)
      const before = await tree(parent)
      let injected = 0
      setIntervention(async (op, args) => {
        if (op === 'readdir' && String(args[0]) === parent) { injected++; throw fault('EACCES', parent) }
      })
      await gc.cleanupOrphanedPluginVersionsInBackground()
      setIntervention(undefined)
      await observe(selected, { parent, injected, before, after: await tree(parent), interventions })
      expect(injected).toBeGreaterThan(0)
      expect(await tree(parent)).toEqual(before)
    } else if (selected === 'ordinary-file-container') {
      const parent = join(cache, 'ordinary/plugin')
      await real.mkdir(parent, { recursive: true })
      await real.writeFile(join(parent, 'receipt.txt'), 'OWNED_ORDINARY_LEAF_OFFICIAL_MAY_DELETE')
      await gc.cleanupOrphanedPluginVersionsInBackground()
      await observe(selected, { parent, after: await tree(parent), interventions })
      expect(await tree(parent)).toBe(null)
    } else if (selected === 'special-container') {
      const parent = join(cache, 'special/plugin'), fifo = join(parent, 'owned-fifo')
      await real.mkdir(parent, { recursive: true })
      const argv = ['/usr/bin/mkfifo', fifo]
      const result = Bun.spawnSync(argv, { env: process.env, stdout: 'pipe', stderr: 'pipe' })
      expect(result.exitCode).toBe(0)
      expect((await real.lstat(fifo)).isFIFO()).toBe(true)
      const before = await tree(parent)
      await gc.cleanupOrphanedPluginVersionsInBackground()
      await observe(selected, { oracleRole: 'known-fifo-deletion-control', argv, exitCode: result.exitCode, parent, before, after: await tree(parent) })
      expect(await tree(parent)).toBe(null)
    } else if (selected === 'container-refill') {
      const parent = join(cache, 'refill/plugin'), receipt = join(parent, 'receipt.txt'), archive = join(parent, 'arrived.zip')
      await real.mkdir(parent, { recursive: true }); await real.writeFile(receipt, 'OWNED_ORDINARY_LEAF')
      let injected = 0, parentReadCalls = 0
      const phaseReceipts: Array<{ op: string; ordinal: number; receiptPresent: boolean; archivePresent: boolean }> = []
      setIntervention(async (op, args) => {
        if (String(args[0]) !== parent) return
        if (op === 'readdir') {
          parentReadCalls++
          phaseReceipts.push({ op, ordinal: parentReadCalls, receiptPresent: await tree(receipt) !== null, archivePresent: await tree(archive) !== null })
          return
        }
        if (injected || (op !== 'rm' && op !== 'unlink')) return
        // Only the first physical-entry attempt with the original child still present.
        // Final RA/rmdir refill is a separate boundary and must not be injected here.
        const receiptPresent = await tree(receipt) !== null, archivePresent = await tree(archive) !== null
        if (receiptPresent && !archivePresent) {
          phaseReceipts.push({ op, ordinal: 1, receiptPresent, archivePresent })
          injected++
          await real.writeFile(archive, 'OWNED_REFILL_AT_DELETE_BOUNDARY')
        }
      })
      await gc.cleanupOrphanedPluginVersionsInBackground()
      setIntervention(undefined)
      await observe(selected, { oracleRole: 'post-guard-pre-child-snapshot-zip-deletion-control', parent, injected, parentReadCalls, phaseReceipts, after: await tree(parent), interventions })
      expect(injected).toBe(1)
      expect(parentReadCalls).toBeGreaterThan(0)
      expect(phaseReceipts.some(row => row.op === 'readdir' && row.receiptPresent && !row.archivePresent)).toBe(true)
      expect(phaseReceipts.find(row => row.op === 'rm' || row.op === 'unlink')).toMatchObject({ ordinal: 1, receiptPresent: true, archivePresent: false })
      expect(await tree(parent)).toBe(null)
    }
    console.log(`PL1_A_CASE_SETTLED ${selected}`)
  } finally {
    setIntervention(undefined)
    clock.mockRestore()
    await observe('resource-summary', { selected, sourceOnly: true, pendingHeldOperations: 0, originalInstalledFile: relative(ownedRoot, installedPath) })
  }
}, 10000)

}
