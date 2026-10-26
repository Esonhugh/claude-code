import { afterAll, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsJson } from '../settings/types.js'

const childFlag = 'CLAUDE_CODE_SANDBOX_ADAPTER_CHILD'

// Other test files mock.module() the sandbox adapter, so run in a fresh process.
if (process.env[childFlag] !== '1') {
  test('sandbox adapter (isolated)', async () => {
    const child = Bun.spawn(
      [process.execPath, 'test', '--timeout', '30000', import.meta.path],
      {
        cwd: join(import.meta.dir, '../../..'),
        env: { ...process.env, [childFlag]: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
    VERSION: 'test',
  }
  const { setCachedSettingsForSource, setSessionSettingsCache } = await import(
    '../settings/settingsCache.js'
  )
  const {
    getAllowedSettingSources,
    setAllowedSettingSources,
    setCwdState,
    setInlinePlugins,
    setOriginalCwd,
  } = await import(
    '../../bootstrap/state.js'
  )
  const { SandboxManager, convertToSandboxRuntimeConfig } = await import(
    './sandbox-adapter.js'
  )

  const project = mkdtempSync(join(tmpdir(), 'cc-sandbox-adapter-'))
  setOriginalCwd(project)
  setCwdState(project)
  setSessionSettingsCache({ settings: {}, errors: [] })
  afterAll(() => rmSync(project, { recursive: true, force: true }))

  test('project folders named hooks/ or config/ stay writable and are kept', () => {
    mkdirSync(join(project, 'hooks'))
    mkdirSync(join(project, 'config'))
    const { denyWrite } = convertToSandboxRuntimeConfig({}).filesystem
    expect(denyWrite).not.toContain(join(project, 'hooks'))
    expect(denyWrite).not.toContain(join(project, 'config'))
    rmSync(join(project, 'hooks'), { recursive: true })
    rmSync(join(project, 'config'), { recursive: true })

    writeFileSync(join(project, 'config'), 'x')
    expect(convertToSandboxRuntimeConfig({}).filesystem.denyWrite).toContain(
      join(project, 'config'),
    )
    rmSync(join(project, 'config'))

    convertToSandboxRuntimeConfig({})
    mkdirSync(join(project, 'hooks'))
    mkdirSync(join(project, 'objects'))
    SandboxManager.cleanupAfterCommand()
    expect(existsSync(join(project, 'hooks'))).toBe(true)
    expect(existsSync(join(project, 'objects'))).toBe(true)
    rmSync(join(project, 'hooks'), { recursive: true })
    rmSync(join(project, 'objects'), { recursive: true })
  })

  test('a planted bare-repo layout loses its markers after the command', () => {
    convertToSandboxRuntimeConfig({})
    writeFileSync(join(project, 'HEAD'), 'ref: refs/heads/main')
    mkdirSync(join(project, 'objects'))
    mkdirSync(join(project, 'refs'))
    writeFileSync(join(project, 'config'), '[core]\n\tfsmonitor = evil')
    SandboxManager.cleanupAfterCommand()
    for (const f of ['HEAD', 'objects', 'refs']) {
      expect({ f, exists: existsSync(join(project, f)) }).toEqual({
        f,
        exists: false,
      })
    }
    rmSync(join(project, 'config'))
  })

  test('an existing bare-repo layout keeps hooks/ and config protected', () => {
    writeFileSync(join(project, 'HEAD'), 'ref: refs/heads/main')
    mkdirSync(join(project, 'objects'))
    mkdirSync(join(project, 'refs'))
    mkdirSync(join(project, 'hooks'))
    const { denyWrite } = convertToSandboxRuntimeConfig({}).filesystem
    for (const f of ['HEAD', 'objects', 'refs', 'hooks']) {
      expect(denyWrite).toContain(join(project, f))
    }
    writeFileSync(join(project, 'config'), '[core]')
    SandboxManager.cleanupAfterCommand()
    expect(existsSync(join(project, 'config'))).toBe(false)
    expect(existsSync(join(project, 'hooks'))).toBe(true)
  })

  test('--plugin-dir folders are write-denied', () => {
    setInlinePlugins([join(project, 'plug'), 'rel-plug'])
    const { denyWrite } = convertToSandboxRuntimeConfig({}).filesystem
    setInlinePlugins([])
    expect(denyWrite).toContain(join(project, 'plug'))
    expect(denyWrite).toContain(join(project, 'rel-plug'))
  })

  test('project and local excludedCommands are dropped under a locked sandbox', () => {
    const sandbox = (excludedCommands: string[], extra = {}) => ({
      sandbox: { excludedCommands, ...extra },
    })
    setCachedSettingsForSource('userSettings', sandbox(['docker:*']))
    setCachedSettingsForSource('projectSettings', sandbox(['cat:*']))
    setCachedSettingsForSource('localSettings', sandbox(['curl:*']))
    setSessionSettingsCache({
      settings: sandbox(['docker:*', 'cat:*', 'curl:*']),
      errors: [],
    })
    try {
      expect(SandboxManager.getExcludedCommands()).toEqual([
        'docker:*',
        'cat:*',
        'curl:*',
      ])
      setCachedSettingsForSource(
        'flagSettings',
        sandbox([], { allowUnsandboxedCommands: false }),
      )
      expect(SandboxManager.getExcludedCommands()).toEqual(['docker:*'])
      setCachedSettingsForSource('flagSettings', null)
      setCachedSettingsForSource('policySettings', {
        sandbox: { network: { allowManagedDomainsOnly: true } },
      })
      expect(SandboxManager.getExcludedCommands()).toEqual(['docker:*'])
    } finally {
      for (const source of [
        'userSettings',
        'projectSettings',
        'localSettings',
        'flagSettings',
        'policySettings',
      ] as const) {
        setCachedSettingsForSource(source, null)
      }
      setSessionSettingsCache({ settings: {}, errors: [] })
    }
  })

  test('sandboxed commands get the per-user TMPDIR', async () => {
    const { SandboxManager: Base } = await import('@anthropic-ai/sandbox-runtime')
    let seen: string | undefined
    const wrap = spyOn(Base, 'wrapWithSandbox').mockImplementation(async c => {
      seen = process.env.CLAUDE_TMPDIR
      return c
    })
    try {
      await SandboxManager.wrapWithSandbox('true')
    } finally {
      wrap.mockRestore()
    }
    expect(seen).toBe(`/tmp/claude-${process.getuid!()}`)
  })

  test('new sandbox settings reach the runtime only from trusted sources', () => {
    const all = [
      'userSettings',
      'projectSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const
    const set = (
      m: Partial<Record<(typeof all)[number], NonNullable<SettingsJson['sandbox']>>>,
    ) => {
      for (const source of all) {
        setCachedSettingsForSource(
          source,
          m[source] ? { sandbox: m[source] } : null,
        )
      }
    }
    try {
      set({
        userSettings: {
          network: { allowedDomains: ['user.example'] },
          credentials: {
            envVars: [{ name: 'GH_TOKEN', mode: 'deny' }],
            files: [{ path: '~/.netrc', mode: 'deny' }],
          },
        },
        projectSettings: {
          network: {
            allowedDomains: ['repo.example'],
            strictAllowlist: false,
            deniedDomains: ['bad.example'],
          },
          ripgrep: { command: '/repo/rg' },
          filesystem: { disabled: true },
          credentials: {
            envVars: [
              { name: 'REPO_DENY', mode: 'deny' },
              { name: 'REPO_MASK', mode: 'mask' },
            ],
          },
        },
        flagSettings: { network: { strictAllowlist: true } },
        policySettings: { bwrapPath: '/opt/bwrap', socatPath: '/opt/socat' },
      })
      const config = convertToSandboxRuntimeConfig({
        sandbox: { network: { deniedDomains: ['bad.example'] } },
      })
      expect(config.network.strictAllowlist).toBe(true)
      expect(config.network.allowedDomains).toEqual(['user.example'])
      expect(config.network.deniedDomains).toContain('bad.example')
      expect(config.ripgrep?.command).not.toBe('/repo/rg')
      expect(config.filesystem.disabled).toBeUndefined()
      expect(config.credentials?.envVars).toEqual([
        { name: 'GH_TOKEN', mode: 'deny' },
        { name: 'REPO_DENY', mode: 'deny' },
      ])
      expect(config.credentials?.files?.[0]?.path).toBe(
        join(process.env.HOME!, '.netrc'),
      )
      expect(config.bwrapPath).toBe('/opt/bwrap')
      expect(config.socatPath).toBe('/opt/socat')

      set({
        userSettings: { filesystem: { disabled: true } },
        projectSettings: { network: { allowedDomains: ['repo.example'] } },
      })
      const loose = convertToSandboxRuntimeConfig({})
      expect(loose.filesystem.disabled).toBe(true)
      expect(loose.network.allowedDomains).toEqual(['repo.example'])
      expect(loose.credentials).toBeUndefined()
      expect(loose.bwrapPath).toBeUndefined()

      set({
        userSettings: { filesystem: { disabled: true } },
        policySettings: { filesystem: { denyRead: ['/secret'] } },
      })
      expect(convertToSandboxRuntimeConfig({}).filesystem.disabled).toBeUndefined()

      set({
        projectSettings: { network: { httpProxyPort: 9999 } },
        flagSettings: { allowUnsandboxedCommands: false },
      })
      expect(
        convertToSandboxRuntimeConfig({
          sandbox: { network: { httpProxyPort: 9999 } },
        }).network.httpProxyPort,
      ).toBeUndefined()
    } finally {
      set({})
    }
  })

  test('a locked or strict sandbox takes network allowances only from trusted sources', () => {
    const user: SettingsJson = {
      sandbox: {
        network: { allowedDomains: ['user.example'], allowUnixSockets: ['/u.sock'] },
      },
      permissions: { allow: ['WebFetch(domain:user-fetch.example)'] },
    }
    const repo: SettingsJson = {
      sandbox: {
        network: {
          allowedDomains: ['repo.example'],
          allowUnixSockets: ['/repo.sock'],
          allowAllUnixSockets: true,
          allowLocalBinding: true,
          allowMachLookup: ['com.repo'],
          httpProxyPort: 9999,
        },
      },
      permissions: { allow: ['WebFetch(domain:repo-fetch.example)'] },
    }
    const merged: SettingsJson = {
      sandbox: {
        network: {
          ...repo.sandbox!.network,
          allowedDomains: ['user.example', 'repo.example'],
          allowUnixSockets: ['/u.sock', '/repo.sock'],
        },
      },
      permissions: {
        allow: [...user.permissions!.allow!, ...repo.permissions!.allow!],
      },
    }
    const sources = ['userSettings', 'projectSettings', 'flagSettings'] as const
    try {
      setCachedSettingsForSource('userSettings', user)
      setCachedSettingsForSource('projectSettings', repo)
      setCachedSettingsForSource('flagSettings', {
        sandbox: { allowUnsandboxedCommands: false },
      })
      const locked = convertToSandboxRuntimeConfig(merged).network
      expect(locked.allowedDomains).toEqual(['user.example', 'user-fetch.example'])
      expect(locked.allowUnixSockets).toEqual(['/u.sock'])
      expect(locked.allowAllUnixSockets).toBeUndefined()
      expect(locked.allowLocalBinding).toBeUndefined()
      expect(locked.allowMachLookup).toBeUndefined()
      expect(locked.httpProxyPort).toBeUndefined()

      setCachedSettingsForSource('flagSettings', {
        sandbox: { network: { strictAllowlist: true } },
      })
      const strict = convertToSandboxRuntimeConfig(merged).network
      expect(strict.allowedDomains).toEqual(['user.example', 'user-fetch.example'])
      expect(strict.allowUnixSockets).toEqual(['/u.sock', '/repo.sock'])
      expect(strict.allowAllUnixSockets).toBe(true)
      expect(strict.httpProxyPort).toBeUndefined()

      setCachedSettingsForSource('flagSettings', null)
      const open = convertToSandboxRuntimeConfig(merged).network
      expect(open.allowedDomains).toEqual([
        'user.example',
        'repo.example',
        'user-fetch.example',
        'repo-fetch.example',
      ])
      expect(open.allowLocalBinding).toBe(true)
      expect(open.httpProxyPort).toBe(9999)
    } finally {
      for (const source of sources) setCachedSettingsForSource(source, null)
    }
  })

  test('a network ask is answered by the permission mode', async () => {
    const { wrapSandboxAskCallback } = await import('./sandbox-adapter.js')
    const host = { host: 'unlisted.example', port: 443 }
    let asked = 0
    const ask = async () => {
      asked++
      return true
    }
    const answer = (mode: string) =>
      wrapSandboxAskCallback(ask, () => ({ mode }) as never)(host)
    setSessionSettingsCache({
      settings: { sandbox: { enabled: true } },
      errors: [],
    })
    setCachedSettingsForSource('userSettings', { sandbox: { enabled: true } })
    try {
      expect(await answer('bypassPermissions')).toBe(true)
      expect(await answer('dontAsk')).toBe(false)
      expect(await answer('auto')).toEqual({
        allow: false,
        reason: expect.stringContaining('allowed_domains'),
      })
      expect(asked).toBe(0)
      expect(await answer('default')).toBe(true)
      expect(asked).toBe(1)

      setCachedSettingsForSource('policySettings', {
        sandbox: { network: { allowManagedDomainsOnly: true } },
      })
      expect(await answer('bypassPermissions')).toBe(false)
    } finally {
      setCachedSettingsForSource('policySettings', null)
      setCachedSettingsForSource('userSettings', null)
      setSessionSettingsCache({ settings: {}, errors: [] })
    }
  })

  test('a linked worktree may write only the main repo .git, minus hooks and config', async () => {
    const main = mkdtempSync(join(tmpdir(), 'cc-sandbox-main-'))
    const wt = mkdtempSync(join(tmpdir(), 'cc-sandbox-wt-'))
    writeFileSync(join(wt, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`)
    setOriginalCwd(wt)
    setCwdState(wt)
    try {
      await SandboxManager.reset()
      setSessionSettingsCache({ settings: { sandbox: { enabled: true } }, errors: [] })
      const base = await import('@anthropic-ai/sandbox-runtime')
      const init = spyOn(base.SandboxManager, 'initialize').mockResolvedValue()
      const enabled = spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(true)
      // initialize() checks the internal isSandboxingEnabled(), which needs bwrap/socat on Linux.
      const deps = spyOn(base.SandboxManager, 'checkDependencies').mockReturnValue({ errors: [], warnings: [] })
      try {
        await SandboxManager.initialize()
        const { allowWrite, denyWrite } = init.mock.calls[0]![0].filesystem
        expect(allowWrite).toContain(join(main, '.git'))
        expect(allowWrite).not.toContain(main)
        expect(denyWrite).toContain(join(main, '.git', 'hooks'))
        expect(denyWrite).toContain(join(main, '.git', 'config'))
      } finally {
        init.mockRestore()
        enabled.mockRestore()
        deps.mockRestore()
        await SandboxManager.reset()
      }
    } finally {
      setSessionSettingsCache({ settings: {}, errors: [] })
      setOriginalCwd(project)
      setCwdState(project)
      rmSync(main, { recursive: true, force: true })
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('the sandbox filesystem config respects --setting-sources', () => {
    const allowed = getAllowedSettingSources()
    setCachedSettingsForSource('userSettings', {
      sandbox: { filesystem: { denyRead: ['/user-secret'] } },
    })
    try {
      expect(convertToSandboxRuntimeConfig({}).filesystem.denyRead).toContain(
        '/user-secret',
      )
      setAllowedSettingSources(['projectSettings'])
      expect(
        convertToSandboxRuntimeConfig({}).filesystem.denyRead,
      ).not.toContain('/user-secret')
    } finally {
      setAllowedSettingSources(allowed)
      setCachedSettingsForSource('userSettings', null)
    }
  })

  test('a locked sandbox drops repo allowRead that re-opens a trusted denyRead', () => {
    setCachedSettingsForSource('userSettings', {
      sandbox: { filesystem: { denyRead: ['/sec'] } },
    })
    setCachedSettingsForSource('projectSettings', {
      sandbox: {
        filesystem: {
          denyRead: ['/repo-deny'],
          allowRead: ['/sec/f', '/repo-deny/ok', '/data/*'],
        },
      },
    })
    try {
      expect(convertToSandboxRuntimeConfig({}).filesystem.allowRead).toEqual(
        expect.arrayContaining(['/sec/f', '/repo-deny/ok', '/data/*']),
      )
      setCachedSettingsForSource('flagSettings', {
        sandbox: { allowUnsandboxedCommands: false },
      })
      const { allowRead } = convertToSandboxRuntimeConfig({}).filesystem
      expect(allowRead).toContain('/repo-deny/ok')
      expect(allowRead).not.toContain('/sec/f')
      expect(allowRead).not.toContain('/data/*')
    } finally {
      for (const source of ['userSettings', 'projectSettings', 'flagSettings'] as const) {
        setCachedSettingsForSource(source, null)
      }
    }
  })
}
