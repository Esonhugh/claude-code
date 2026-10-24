import { afterAll, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  const { setCwdState, setInlinePlugins, setOriginalCwd } = await import(
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
}
