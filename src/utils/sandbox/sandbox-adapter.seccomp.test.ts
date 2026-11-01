import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childFlag = 'CLAUDE_CODE_SANDBOX_ADAPTER_SECCOMP_CHILD'

// Other test files mock.module() the sandbox adapter, so run in a fresh process.
if (process.env[childFlag] !== '1') {
  test('sandbox adapter apply-seccomp (isolated)', async () => {
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
  const temp = mkdtempSync(join(tmpdir(), 'cc-sandbox-seccomp-'))
  afterAll(() => rmSync(temp, { recursive: true, force: true }))
  const embedded = join(temp, 'embedded-apply-seccomp')
  writeFileSync(embedded, 'apply-seccomp')
  process.env.CLAUDE_CODE_EMBEDDED_APPLY_SECCOMP_PATH = embedded
  process.env.CLAUDE_CODE_EMBEDDED_APPLY_SECCOMP_VERSION = '0.0.80'
  process.env.XDG_CACHE_HOME = join(temp, 'cache')

  const { CACHE_PATHS } = await import('../cachePaths.js')
  const { convertToSandboxRuntimeConfig, getApplySeccompPath } = await import(
    './sandbox-adapter.js'
  )
  const { getPlatform } = await import('../platform.js')

  test('the embedded apply-seccomp is extracted and passed to the runtime', () => {
    const path = getApplySeccompPath()!
    expect(path).toBe(
      join(
        CACHE_PATHS.applySeccomp(),
        `0.0.80-${process.arch}`,
        'apply-seccomp',
      ),
    )
    expect(readFileSync(path, 'utf8')).toBe('apply-seccomp')
    const { seccomp } = convertToSandboxRuntimeConfig({})
    if (getPlatform() === 'linux' || getPlatform() === 'wsl') {
      expect(seccomp).toEqual({ applyPath: path })
    } else {
      expect(seccomp).toBeUndefined()
    }
  })
}
