import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Settings, skills and memory resolve under CLAUDE_CONFIG_DIR and the
// original cwd; both point into temp folders before anything loads them.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'web-ext-')))
const configDir = join(root, 'config')
const workspace = join(root, 'workspace')
mkdirSync(configDir, { recursive: true })
mkdirSync(workspace, { recursive: true })
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDir

const { setOriginalCwd, setCwdState } = await import('../bootstrap/state.js')
const { resetSettingsCache } = await import('../utils/settings/settingsCache.js')
const ext = await import('./extensions.js')
const { startWebServer } = await import('./webServer.js')
const { SessionManager } = await import('../server/sessionManager.js')
const { createServerLogger } = await import('../server/serverLog.js')

const userSettings = () => JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'))

beforeAll(() => {
  setOriginalCwd(workspace)
  setCwdState(workspace)
  resetSettingsCache()
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  rmSync(root, { recursive: true, force: true })
})

describe('parseWebMarketplaceSource', () => {
  it('accepts owner/repo and https URLs only', () => {
    expect(ext.parseWebMarketplaceSource('anthropics/claude-plugins-official')).toBe(
      'anthropics/claude-plugins-official',
    )
    expect(ext.parseWebMarketplaceSource(' https://github.com/a/b.git ')).toBe('https://github.com/a/b.git')
    for (const bad of [
      '/etc/passwd',
      './plugins',
      '../x',
      '~/market',
      'git@github.com:a/b.git',
      'http://example.com/m.json',
      'https://user:pw@example.com/m.json',
      'file:///etc/passwd',
      'a/b c',
      '--upload-pack=x',
    ]) {
      expect(ext.parseWebMarketplaceSource(bad)).toBeUndefined()
    }
  })
})

describe('scanModSource', () => {
  it('finds the events and UI components a mod registers', () => {
    const src = `export default $ => {
      $.on('turn.complete', async () => {})
      $.on("ui.render", { component: 'AbovePrompt' }, async () => {})
      $.command.register('replay', () => {})
    }`
    expect(ext.scanModSource(src)).toEqual({
      events: ['turn.complete', 'ui.render', 'command.run'],
      surfaces: ['AbovePrompt'],
    })
  })
})

describe('hooks', () => {
  it('adds, edits and deletes a user hook in settings.json', async () => {
    ext.addHook({ event: 'PreToolUse', matcher: 'Bash', command: '~/block-rm.sh', timeout: 10, source: 'user' })
    expect(userSettings().hooks).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/block-rm.sh', timeout: 10 }] }],
    })
    let row = (await ext.listHooks()).hooks.find(h => h.command === '~/block-rm.sh')!
    expect(row).toMatchObject({ event: 'PreToolUse', matcher: 'Bash', source: 'user', timeout: 10 })

    ext.updateHook(row.id!, { event: 'Stop', matcher: '', command: 'echo done', timeout: 5, source: 'user' })
    expect(userSettings().hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'echo done', timeout: 5 }] }] })

    row = (await ext.listHooks()).hooks.find(h => h.command === 'echo done')!
    ext.deleteHook(row.id!)
    expect(userSettings().hooks).toEqual({})
  })

  it('writes project hooks to the workspace settings', () => {
    ext.addHook({ event: 'PostToolUse', matcher: 'Write|Edit', command: 'prettier --write', source: 'project' })
    const project = JSON.parse(readFileSync(join(workspace, '.claude', 'settings.json'), 'utf8'))
    expect(project.hooks.PostToolUse[0].matcher).toBe('Write|Edit')
  })

  it('toggles disableAllHooks', async () => {
    ext.setHooksDisabled(true)
    expect(userSettings().disableAllHooks).toBe(true)
    expect((await ext.listHooks()).disabled).toBe(true)
    ext.setHooksDisabled(false)
    expect(userSettings().disableAllHooks).toBeUndefined()
  })

  it('rejects bad ids and input', () => {
    expect(() => ext.deleteHook('policySettings:Stop:0:0')).toThrow('Invalid hook id')
    expect(() => ext.deleteHook('userSettings:NoSuchEvent:0:0')).toThrow('Invalid hook id')
    expect(() => ext.deleteHook('userSettings:Stop:9:9')).toThrow('Hook not found')
    const ok = { event: 'Stop', matcher: '', command: 'x', source: 'user' }
    expect(ext.hookInputSchema.safeParse(ok).success).toBe(true)
    expect(ext.hookInputSchema.safeParse({ ...ok, event: 'Nope' }).success).toBe(false)
    expect(ext.hookInputSchema.safeParse({ ...ok, timeout: 0 }).success).toBe(false)
    expect(ext.hookInputSchema.safeParse({ ...ok, command: '  ' }).success).toBe(false)
    expect(ext.hookInputSchema.safeParse({ ...ok, matcher: 'a\nb' }).success).toBe(false)
    expect(ext.hookInputSchema.safeParse({ ...ok, source: 'policy' }).success).toBe(false)
  })
})

describe('skills', () => {
  it('lists a user skill, previews SKILL.md and turns it off in local settings', async () => {
    const dir = join(configDir, 'skills', 'weekly-report')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: weekly-report\ndescription: 把本周会话整理成周报\n---\n# 步骤\n')
    const skill = (await ext.listSkills()).find(s => s.name === 'weekly-report')!
    expect(skill).toMatchObject({ group: 'user', on: true, toggleable: true, description: '把本周会话整理成周报' })
    expect((await ext.skillContent('weekly-report')).content).toContain('# 步骤')

    await ext.setSkillEnabled('weekly-report', false)
    const local = JSON.parse(readFileSync(join(workspace, '.claude', 'settings.local.json'), 'utf8'))
    expect(local.skillOverrides).toEqual({ 'weekly-report': 'off' })
    expect((await ext.listSkills()).find(s => s.name === 'weekly-report')!.on).toBe(false)
    await ext.setSkillEnabled('weekly-report', true)
    expect((await ext.listSkills()).find(s => s.name === 'weekly-report')!.on).toBe(true)

    await expect(ext.skillContent('../etc')).rejects.toThrow('Invalid skill name')
    await expect(ext.skillContent('no-such-skill')).rejects.toThrow('Skill not found')
  })
})

describe('memory', () => {
  it('lists CLAUDE.md files with their text', async () => {
    writeFileSync(join(configDir, 'CLAUDE.md'), '# 偏好\n- 默认使用中文回答。\n')
    writeFileSync(join(workspace, 'CLAUDE.md'), '# 论文评审项目\n')
    const list = await ext.listMemory()
    expect(list.files.find(f => f.kind === 'user')?.body).toContain('默认使用中文回答')
    expect(list.files.find(f => f.kind === 'project')?.body).toContain('论文评审项目')
    expect(list.files.every(f => !('path' in f))).toBe(true)
  })

  it('switches auto memory and the FTS index in user settings', () => {
    ext.setMemoryToggle('autoMemory', false)
    ext.setMemoryToggle('sqlite', true)
    expect(userSettings()).toMatchObject({ autoMemoryEnabled: false, memory: { sqlite: { enabled: true } } })
    ext.setMemoryToggle('autoMemory', true)
    ext.setMemoryToggle('sqlite', false)
  })
})

describe('channels', () => {
  it('stores default --channels entries and ignores invalid ones', async () => {
    await ext.setDefaultChannel(configDir, 'telegram@claude-plugins-official', true)
    expect(ext.readDefaultChannels(configDir)).toEqual(['plugin:telegram@claude-plugins-official'])
    await expect(ext.setDefaultChannel(configDir, 'telegram', true)).rejects.toThrow('plugin@marketplace')
    await expect(ext.setDefaultChannel(configDir, '../x@y', true)).rejects.toThrow('Invalid plugin id')
    writeFileSync(join(configDir, 'web', 'channels.json'), JSON.stringify({ channels: ['server:evil', 'plugin:a@b'] }))
    expect(ext.readDefaultChannels(configDir)).toEqual(['plugin:a@b'])
    await ext.setDefaultChannel(configDir, 'a@b', false)
    expect(ext.readDefaultChannels(configDir)).toEqual([])
  })
})

describe('/api/ext endpoints', () => {
  const TOKEN = 'ext-test-token'
  const start = () => {
    const manager = new SessionManager({
      spawn: () => spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'] }),
    })
    const server = startWebServer(
      {
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        cookieKey: Buffer.alloc(32, 2),
        workspace,
        uploadsDir: join(configDir, 'web', 'uploads'),
        configDir,
      },
      manager,
      new Map(),
      createServerLogger({ write: () => {} }),
    )
    return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
  }

  it('needs the cookie and same origin, validates bodies, and round-trips a hook', async () => {
    const { base, stop } = start()
    try {
      expect((await fetch(`${base}/api/ext/hooks`)).status).toBe(401)
      const signIn = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' })
      const cookie = (signIn.headers.get('set-cookie') ?? '').split(';')[0]!
      const send = (method: string, path: string, body?: unknown, origin = base) =>
        fetch(`${base}${path}`, {
          method,
          headers: { cookie, origin, 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        })
      const hook = { event: 'UserPromptSubmit', matcher: '', command: 'python add-date.py', timeout: 5, source: 'user' }
      expect((await send('POST', '/api/ext/hooks', hook, 'http://evil.example')).status).toBe(403)
      expect((await send('POST', '/api/ext/hooks', { ...hook, event: 'Nope' })).status).toBe(400)
      expect((await send('POST', '/api/ext/hooks', hook)).status).toBe(204)
      const listed = (await (await send('GET', '/api/ext/hooks')).json()) as { hooks: { id?: string; command: string }[] }
      const row = listed.hooks.find(h => h.command === 'python add-date.py')!
      expect((await send('DELETE', '/api/ext/hooks', { id: row.id })).status).toBe(204)
      expect(userSettings().hooks?.UserPromptSubmit).toBeUndefined()

      expect((await send('PUT', '/api/ext/skills/..%2F..%2Fetc', { on: false })).status).toBe(400)
      expect((await send('POST', '/api/ext/plugins', { id: '../../x', action: 'install' })).status).toBe(400)
      expect((await send('POST', '/api/ext/plugins', { id: 'x', action: 'rm -rf' })).status).toBe(400)
      expect((await send('POST', '/api/ext/marketplaces', { source: '/etc' })).status).toBe(400)
      expect((await send('PUT', '/api/ext/mods/..%2Fx/source', { source: '' })).status).toBe(400)
      expect((await send('GET', '/api/ext/nope')).status).toBe(404)
      const stats = (await (await send('GET', '/api/ext/stats')).json()) as { hours: number[] }
      expect(stats.hours).toHaveLength(24)
    } finally {
      stop()
    }
  })
})
