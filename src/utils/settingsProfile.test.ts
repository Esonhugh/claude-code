import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsProfileForArgs } from './settingsProfile.js'

if (!process.env.SETTINGS_PROFILE_CHILD) {
  describe('settingsProfileForArgs', () => {
    test('claude web and the desktop sidecar', () => {
      expect(settingsProfileForArgs(['web'])).toBe('web')
      expect(settingsProfileForArgs(['web', '--port', '0', '--no-open'])).toBe('web')
      expect(settingsProfileForArgs(['web', '--stdio'])).toBe('desktop')
    })

    test('root flags web forwards may come first', () => {
      expect(settingsProfileForArgs(['--settings', 'x.json', 'web'])).toBe('web')
      expect(settingsProfileForArgs(['--plugin-dir', 'web', 'web', '--stdio'])).toBe('desktop')
      expect(settingsProfileForArgs(['--debug', '--setting-sources=user', 'web'])).toBe('web')
    })

    test('anything else keeps the shared files', () => {
      expect(settingsProfileForArgs([])).toBeUndefined()
      expect(settingsProfileForArgs(['-p', 'hello web'])).toBeUndefined()
      expect(settingsProfileForArgs(['mcp', 'web'])).toBeUndefined()
      expect(settingsProfileForArgs(['--settings', 'web'])).toBeUndefined()
      expect(settingsProfileForArgs(['web', '--', '--stdio'])).toBe('web')
    })
  })

  // The paths are memoized and NODE_ENV=test stubs the config, so each case is its own process.
  async function run(profile: string | undefined, setup: (configDir: string) => void = () => {}) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'settings-profile-')))
    const configDir = join(home, 'config')
    mkdirSync(configDir)
    setup(configDir)
    const child = Bun.spawn([process.execPath, import.meta.path], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        SETTINGS_PROFILE_CHILD: '1',
        ...(profile !== undefined ? { CLAUDE_CODE_SETTINGS_PROFILE: profile } : {}),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
    return { configDir, out: JSON.parse(stdout) as Record<string, string | undefined>, read }
  }

  const shared = (configDir: string) => {
    writeFileSync(join(configDir, 'settings.json'), '{\n  "env": { "ANTHROPIC_BASE_URL": "http://cli" },\n  "uiName": "cli"\n}\n')
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ numStartups: 7 }))
  }

  test('first launch copies the shared files, then writes stay in the profile', async () => {
    const { configDir, out, read } = await run('web', shared)
    const dir = join(configDir, 'web')
    expect(out.userSettings).toBe(join(dir, 'settings.json'))
    expect(out.globalConfig).toBe(join(dir, '.claude.json'))
    expect(out.sharedUserSettings).toBe(join(configDir, 'settings.json'))
    // Edits to the CLI's settings.json still ask, although this process doesn't read it.
    expect(out.sharedIsGuarded).toBe('true')
    // The child read the copies before it wrote.
    expect(out.uiNameBefore).toBe('cli')
    expect(out.numStartupsBefore).toBe('7')
    expect(JSON.parse(read(join(dir, 'settings.json'))!)).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://cli' }, uiName: 'web' })
    expect(JSON.parse(read(join(dir, '.claude.json'))!)).toMatchObject({ numStartups: 8 })
    expect(read(join(configDir, 'settings.json'))).toContain('"uiName": "cli"')
    expect(JSON.parse(read(join(configDir, '.claude.json'))!)).toEqual({ numStartups: 7 })
    expect(statSync(join(dir, 'settings.json')).mode & 0o777).toBe(0o600)
  }, 60000)

  test('a profile file that exists is not replaced', async () => {
    const { configDir, out } = await run('desktop', dir => {
      shared(dir)
      mkdirSync(join(dir, 'desktop'))
      writeFileSync(join(dir, 'desktop', 'settings.json'), '{"uiName":"desktop"}')
    })
    expect(out.userSettings).toBe(join(configDir, 'desktop', 'settings.json'))
    expect(out.uiNameBefore).toBe('desktop')
  }, 60000)

  test('with nothing to copy the profile starts empty', async () => {
    const { configDir, read } = await run('web')
    expect(JSON.parse(read(join(configDir, 'web', 'settings.json'))!)).toEqual({ uiName: 'web' })
    expect(read(join(configDir, 'settings.json'))).toBeUndefined()
  }, 60000)

  test('no profile, an empty one or an invalid name uses the shared files', async () => {
    for (const profile of [undefined, '', '../x']) {
      const { configDir, out } = await run(profile, shared)
      expect(out.userSettings).toBe(join(configDir, 'settings.json'))
      expect(out.sharedUserSettings).toBeUndefined()
      expect(existsSync(join(configDir, 'web'))).toBe(false)
    }
  }, 60000)
} else {
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const { enableConfigs, getGlobalConfig, saveGlobalConfig } = await import('./config.js')
  const { getGlobalClaudeFile } = await import('./env.js')
  const { getSettingsFilePathForSource, getSettingsForSource, getSharedUserSettingsFilePath, updateSettingsForSource } =
    await import('./settings/settings.js')
  const { isClaudeSettingsPath } = await import('./permissions/filesystem.js')
  enableConfigs()
  const uiNameBefore = getSettingsForSource('userSettings')?.uiName
  const numStartupsBefore = String(getGlobalConfig().numStartups)
  const { error } = updateSettingsForSource('userSettings', { uiName: 'web' })
  if (error) throw error
  saveGlobalConfig(current => ({ ...current, numStartups: current.numStartups + 1 }))
  process.stdout.write(
    JSON.stringify({
      userSettings: getSettingsFilePathForSource('userSettings'),
      globalConfig: getGlobalClaudeFile(),
      sharedUserSettings: getSharedUserSettingsFilePath(),
      sharedIsGuarded: String(isClaudeSettingsPath(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'))),
      uiNameBefore,
      numStartupsBefore,
    }),
  )
}
