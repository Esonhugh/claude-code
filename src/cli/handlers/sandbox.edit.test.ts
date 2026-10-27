import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_SANDBOX_EDIT_TEST_CHILD'

// Writes real settings files, so run in a fresh process with its own HOME.
if (process.env[childFlag] !== '1') {
  test('edit-sandbox-settings (isolated)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-sandbox-edit-home-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { setCwdState, setFlagSettingsPath, setOriginalCwd } = await import('../../bootstrap/state.js')
  const { resetSettingsCache } = await import('../../utils/settings/settingsCache.js')
  const managedPath = await import('../../utils/settings/managedPath.js')
  const { SandboxManager } = await import('../../utils/sandbox/sandbox-adapter.js')
  const { runSandboxSettingsEdit } = await import('./sandbox.js')
  const { buildSandboxDialogResponse } = await import('../hostControlRequests.js')

  const project = mkdtempSync(join(tmpdir(), 'cc-sandbox-edit-'))
  const home = process.env.CLAUDE_CONFIG_DIR!
  const flagFile = join(project, 'flag.json')
  const managedFile = join(home, 'managed-settings.json')
  setOriginalCwd(project)
  setCwdState(project)
  spyOn(managedPath, 'getManagedFilePath').mockReturnValue(home)
  spyOn(SandboxManager, 'isSupportedPlatform').mockReturnValue(true)
  const deps = spyOn(SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] })
  afterAll(() => rmSync(project, { recursive: true, force: true }))

  const local = () => JSON.parse(readFileSync(join(project, '.claude', 'settings.local.json'), 'utf8'))
  beforeEach(() => {
    rmSync(join(project, '.claude'), { recursive: true, force: true })
    rmSync(join(home, 'settings.json'), { force: true })
    setFlagSettingsPath(undefined)
    deps.mockReturnValue({ errors: [], warnings: [] })
    resetSettingsCache()
  })

  test('mode, fallback and exclusion edits land in local settings and show in the dialog', async () => {
    expect(await runSandboxSettingsEdit({ mode: 'regular' })).toEqual({ ok: true, written: { mode: 'regular' } })
    expect(local().sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: false })
    expect(await runSandboxSettingsEdit({ allowUnsandboxedCommands: false, excludeCommand: '"npm test"' })).toMatchObject({ ok: true })
    expect(local().sandbox).toMatchObject({ allowUnsandboxedCommands: false, excludedCommands: ['npm test'] })
    expect(buildSandboxDialogResponse()).toMatchObject({
      supported: true,
      enabled_in_settings: true,
      mode: 'regular',
      unsandboxed_fallback: false,
      overrides_locked: false,
      excluded_commands: ['npm test'],
    })
    expect((await runSandboxSettingsEdit({ mode: 'disabled' })).ok).toBe(true)
    expect(buildSandboxDialogResponse().mode).toBe('disabled')
  })

  test('the dialog lists filesystem grants as written in the settings', () => {
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ sandbox: { filesystem: { allowRead: ['~/secret/ok'], allowWrite: ['./out'] } } }),
    )
    resetSettingsCache()
    expect(buildSandboxDialogResponse().restrictions).toMatchObject({
      fs_allow_read: ['~/secret/ok'],
      fs_allow_write: ['./out'],
    })
  })

  test('malformed edits are refused with the reason', async () => {
    expect(await runSandboxSettingsEdit({})).toEqual({
      ok: false,
      error: 'Not a sandbox settings edit (edit: Nothing to change: none of mode, allowUnsandboxedCommands or excludeCommand was given.).',
    })
    expect(await runSandboxSettingsEdit({ mode: 'regular', x: 1 })).toEqual({
      ok: false,
      error: 'Not a sandbox settings edit (edit: Unrecognized key: "x").',
    })
  })

  test('missing dependencies block turning the sandbox on, not off', async () => {
    deps.mockReturnValue({ errors: ['bubblewrap (bwrap) not installed'], warnings: [] })
    expect(await runSandboxSettingsEdit({ mode: 'auto-allow' })).toEqual({
      ok: false,
      error: 'The sandbox cannot run on this machine yet: bubblewrap (bwrap) not installed',
    })
    expect((await runSandboxSettingsEdit({ mode: 'disabled' })).ok).toBe(true)
  })

  test('a policy lock or a closed fallback in trusted settings refuses the edit', async () => {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ sandbox: { allowUnsandboxedCommands: false } }))
    resetSettingsCache()
    expect(buildSandboxDialogResponse()).toMatchObject({ locked: false, overrides_locked: true })
    expect(await runSandboxSettingsEdit({ allowUnsandboxedCommands: true })).toMatchObject({ ok: false })

    writeFileSync(flagFile, JSON.stringify({ sandbox: { enabled: true } }))
    setFlagSettingsPath(flagFile)
    resetSettingsCache()
    expect(buildSandboxDialogResponse()).toMatchObject({ locked: true, overrides_locked: true })
    expect(await runSandboxSettingsEdit({ mode: 'disabled' })).toEqual({
      ok: false,
      error: 'Sandbox settings are set by a higher-priority configuration and cannot be changed here.',
    })
  })

  test('under a mandated sandbox an exclusion goes to user settings', async () => {
    writeFileSync(managedFile, JSON.stringify({ sandbox: { network: { allowManagedDomainsOnly: true } } }))
    resetSettingsCache()
    try {
      expect(buildSandboxDialogResponse().restrictions.network_managed).toBe(true)
      expect(await runSandboxSettingsEdit({ excludeCommand: 'docker:*' })).toMatchObject({ ok: true })
      expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')).sandbox.excludedCommands).toEqual(['docker:*'])
      expect(SandboxManager.getExcludedCommands()).toEqual(['docker:*'])
    } finally {
      rmSync(managedFile)
    }
  })
}
