import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const phase = process.env.CONFIG_PATH_TRUST_PHASE

if (!phase) {
  async function checkTrust(...phases: string[]) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'config-path-trust-')))
    try {
      const configDir = join(home, 'config')
      for (const dir of [join(configDir, 'desktop'), join(home, 'selected'), join(home, 'other')]) mkdirSync(dir, { recursive: true })
      writeFileSync(join(configDir, 'desktop', '.claude.json'), JSON.stringify({ editorMode: 'vim' }))
      // The normal writer is replaced by an in-memory stub under NODE_ENV=test.
      for (const phase of phases) {
        const child = Bun.spawn([process.execPath, import.meta.path], {
          cwd: home,
          env: {
            PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home, SystemRoot: process.env.SystemRoot,
            CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_SETTINGS_PROFILE: 'desktop',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CONFIG_PATH_TRUST_PHASE: phase,
          },
          stdout: 'ignore', stderr: 'pipe',
        })
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  test('persists confirmed path trust without replacing other project settings', () => checkTrust('confirm', 'reload'))
  test('confirming trust already written by another process refreshes the cache without writing', () => checkTrust('already-confirmed'))
  test('a locked read rejected by the onboarding guard does not refresh trust', () => checkTrust('reject'))
} else {
  Object.assign(globalThis, { MACRO: { VERSION: 'test' } })
  const { enableConfigs, isPathTrusted, savePathTrusted } = await import('./config.js')
  const { getGlobalClaudeFile } = await import('./env.js')
  const { normalizePathForConfigKey } = await import('./path.js')
  const selected = normalizePathForConfigKey(join(process.cwd(), 'selected'))
  const other = normalizePathForConfigKey(join(process.cwd(), 'other'))
  const untouched = { allowedTools: ['Read'] }
  const file = getGlobalClaudeFile()
  if (phase === 'reject') writeFileSync(file, JSON.stringify({ editorMode: 'vim', hasCompletedOnboarding: true }))
  enableConfigs()
  if (phase === 'confirm') {
    assert.equal(isPathTrusted(selected), false)
    assert.equal(isPathTrusted(other), false)
    // Emulate another process updating project settings after we loaded the config.
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), projects: { [other]: untouched } }))
    savePathTrusted(selected)
  }
  if (phase === 'already-confirmed' || phase === 'reject') {
    assert.equal(isPathTrusted(selected), false)
    // Keep this process on the same call stack so its watcher cannot see the other writer.
    const writer = Bun.spawnSync([process.execPath, import.meta.path], {
      env: { ...process.env, CONFIG_PATH_TRUST_PHASE: 'confirm' },
    })
    assert.equal(writer.exitCode, 0, writer.stderr.toString())
    assert.equal(isPathTrusted(selected), false)
    if (phase === 'reject') {
      const latest = JSON.parse(readFileSync(file, 'utf8'))
      delete latest.hasCompletedOnboarding
      writeFileSync(file, JSON.stringify(latest))
    }
    const contents = readFileSync(file, 'utf8')
    const { ino, mtimeNs } = statSync(file, { bigint: true })
    savePathTrusted(selected)
    assert.equal(isPathTrusted(selected), phase === 'already-confirmed')
    assert.equal(readFileSync(file, 'utf8'), contents)
    const after = statSync(file, { bigint: true })
    assert.equal(after.ino, ino)
    assert.equal(after.mtimeNs, mtimeNs)
  }
  if (phase !== 'reject') assert.equal(isPathTrusted(selected), true)
  assert.equal(isPathTrusted(other), false)
  const disk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(disk.projects[selected].hasTrustDialogAccepted, true)
  assert.deepEqual(disk.projects[other], untouched)
  assert.equal(disk.editorMode, 'vim')
}
