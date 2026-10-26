import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_SANDBOX_ADAPTER_WINDOWS_CHILD'

// Other test files mock.module() the sandbox adapter, so run in a fresh process.
if (process.env[childFlag] !== '1') {
  test('sandbox adapter on Windows (isolated)', async () => {
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
  const temp = mkdtempSync(join(tmpdir(), 'cc-sandbox-windows-'))
  afterAll(() => rmSync(temp, { recursive: true, force: true }))
  const embedded = join(temp, 'embedded-srt-win.exe')
  writeFileSync(embedded, 'srt-win')
  process.env.CLAUDE_CODE_EMBEDDED_SRT_WIN_PATH = embedded
  process.env.CLAUDE_CODE_EMBEDDED_SRT_WIN_VERSION = '0.0.80'
  process.env.XDG_CACHE_HOME = join(temp, 'cache')

  const platform = await import('../platform.js')
  mock.module('../platform.js', () => ({
    ...platform,
    getPlatform: () => 'windows',
  }))
  const runtime = await import('@anthropic-ai/sandbox-runtime')
  let user = {
    provisioned: false,
    credPresent: false,
    sid: undefined as string | undefined,
  }
  mock.module('@anthropic-ai/sandbox-runtime', () => ({
    ...runtime,
    getWindowsSandboxUserStatus: () => user,
  }))
  const childProcess = await import('child_process')
  const icacls: string[][] = []
  mock.module('child_process', () => ({
    ...childProcess,
    execFileSync: (file: string, args: string[]) => {
      icacls.push([file, ...args])
      return Buffer.from('')
    },
  }))

  const { setSessionSettingsCache } = await import(
    '../settings/settingsCache.js'
  )
  const { setCwdState, setOriginalCwd } = await import(
    '../../bootstrap/state.js'
  )
  const { CACHE_PATHS } = await import('../cachePaths.js')
  const { SandboxManager, convertToSandboxRuntimeConfig, getSrtWinPath } =
    await import('./sandbox-adapter.js')
  setOriginalCwd(temp)
  setCwdState(temp)
  setSessionSettingsCache({
    settings: { sandbox: { enabled: true } },
    errors: [],
  })

  test('the embedded srt-win is extracted and passed to the runtime', () => {
    const path = getSrtWinPath()!
    expect(path).toBe(
      join(CACHE_PATHS.srtWin(), `0.0.80-${process.arch}`, 'srt-win.exe'),
    )
    expect(path.startsWith(join(temp, 'cache'))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('srt-win')
    expect(convertToSandboxRuntimeConfig({}).windows).toEqual({
      srtWin: { path },
    })
  })

  test('write denies outside every write grant are left out', () => {
    const { denyWrite } = convertToSandboxRuntimeConfig({}).filesystem
    expect(denyWrite).toContain(join(temp, '.claude', 'settings.json'))
    expect(denyWrite.some(p => p.startsWith(homedir()))).toBe(false)
  })

  test('an uninstalled sandbox is reported, not enabled', () => {
    expect(SandboxManager.isSandboxingEnabled()).toBe(false)
    expect(SandboxManager.getSandboxUnavailableReason()).toContain(
      'claude sandbox install',
    )
    expect(icacls).toEqual([])
  })

  test('an installed sandbox lets its user run srt-win', async () => {
    user = { provisioned: true, credPresent: true, sid: 'S-1-5-21-1-2-3-1004' }
    await SandboxManager.reset()
    expect(SandboxManager.checkDependencies().errors).toEqual([])
    expect(icacls).toEqual([
      ['icacls', getSrtWinPath()!, '/grant', '*S-1-5-21-1-2-3-1004:RX'],
    ])
  })
}
