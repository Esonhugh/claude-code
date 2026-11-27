import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// saveGlobalConfigFile writes any profile's .claude.json; this process runs as
// the `web` profile, so web is the current file and the others are not.
const stored = { numStartups: 37, marker: 'KEEP' }
const PROFILES = { shared: '', web: 'web', desktop: 'desktop' } as const
type Profile = keyof typeof PROFILES

if (!process.env.SAVE_CONFIG_FILE) {
  // NODE_ENV=test replaces the config with an in-memory stub, so each case is its own process.
  async function save(profile: Profile, damage?: 'corrupt' | 'unreadable') {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'save-config-file-')))
    const configDir = join(home, 'config')
    const contents = Object.fromEntries(Object.entries(PROFILES).map(([name, dir]) => {
      mkdirSync(join(configDir, dir), { recursive: true })
      const content = damage === 'corrupt' && name === profile ? '{"numStartups": 37,' : JSON.stringify(stored)
      writeFileSync(join(configDir, dir, '.claude.json'), content)
      return [name, content]
    }))
    const child = Bun.spawn([process.execPath, import.meta.path], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_SETTINGS_PROFILE: 'web',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', SAVE_CONFIG_FILE: profile, SAVE_CONFIG_DAMAGE: damage ?? '' },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (code !== 0) throw new Error(stderr)
    const files = Object.fromEntries(Object.entries(PROFILES).map(([name, dir]) => {
      const backups = join(configDir, dir, 'backups')
      return [name, {
        changed: readFileSync(join(configDir, dir, '.claude.json'), 'utf8') !== contents[name],
        backups: existsSync(backups) ? readdirSync(backups).map(f => f.replace(/\d+$/, '<ts>')) : [],
      }]
    }))
    return { saved: stdout.trim(), disk: damage ? undefined : JSON.parse(readFileSync(join(configDir, PROFILES[profile], '.claude.json'), 'utf8')), files }
  }

  const only = (profile: Profile, backups: string[]) =>
    Object.fromEntries(Object.keys(PROFILES).map(name => [name, name === profile ? { changed: backups.length > 0, backups } : { changed: false, backups: [] }]))

  test.each(['web', 'shared', 'desktop'] as const)('saving the %s file writes it and backs it up in its own backups dir', async profile => {
    const result = await save(profile)
    expect(result.saved).toBe('true')
    expect(result.disk).toMatchObject({ ...stored, numStartups: 38 })
    expect(result.files).toEqual(only(profile, ['.claude.json.backup.<ts>']))
  }, 60000)

  test.each([
    ['doesn\'t parse', 'corrupt'],
    ['can\'t be read', 'unreadable'],
  ] as const)('another profile\'s file that %s is left as it is, and the save says so', async (_label, damage) => {
    const result = await save('desktop', damage)
    expect(result.saved).toBe('false')
    expect(result.files).toEqual(only('desktop', []))
  }, 60000)
} else {
  ;(globalThis as any).MACRO = { VERSION: 'test' }
  const { enableConfigs, saveGlobalConfigFile } = await import('./config.js')
  const { getClaudeConfigHomeDir } = await import('./envUtils.js')
  const { getFsImplementation, setFsImplementation } = await import('./fsOperations.js')
  enableConfigs()
  const file = join(getClaudeConfigHomeDir(), PROFILES[process.env.SAVE_CONFIG_FILE as Profile], '.claude.json')
  if (process.env.SAVE_CONFIG_DAMAGE === 'unreadable') {
    const fs = getFsImplementation()
    setFsImplementation({
      ...fs,
      readFileSync: ((path: string, options: { encoding: BufferEncoding }) => {
        if (path === file) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
        return fs.readFileSync(path, options)
      }) as typeof fs.readFileSync,
    })
  }
  const saved = saveGlobalConfigFile(file, current => ({ ...current, numStartups: current.numStartups + 1 }))
  process.stdout.write(String(saved))
}
