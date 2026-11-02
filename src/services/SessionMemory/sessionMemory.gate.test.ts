import { expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Session memory extraction follows the tengu_session_memory gate (default off,
// like official 2.1.311 and like session-memory compaction), not auto memory.
// Module mocks would leak into other files, so this runs in a child process.
const childFlag = 'CLAUDE_CODE_SESSION_MEMORY_GATE_TEST_CHILD'

if (process.env[childFlag] === undefined) {
  test('session memory extraction stays off with auto memory on (child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-session-memory-gate-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: {
          ...process.env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 60_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { setSessionSettingsCache } = await import('../../utils/settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })

  let configReads = 0
  const growthbook = { ...(await import('../analytics/growthbook.js')) }
  const readConfig = growthbook.getDynamicConfig_CACHED_MAY_BE_STALE
  mock.module('../analytics/growthbook.js', () => ({
    ...growthbook,
    getDynamicConfig_CACHED_MAY_BE_STALE: <T>(name: string, value: T): T => {
      if (name === 'tengu_sm_config') configReads++
      return readConfig(name, value)
    },
  }))

  const { isAutoMemoryEnabled } = await import('../../memdir/paths.js')
  const { executePostSamplingHooks } = await import('../../utils/hooks/postSamplingHooks.js')
  const { initSessionMemory } = await import('./sessionMemory.js')

  test('the post-sampling hook returns at the gate', async () => {
    expect(isAutoMemoryEnabled()).toBe(true)
    initSessionMemory()
    await executePostSamplingHooks([], [] as never, {}, {}, {} as never, 'repl_main_thread')
    expect(configReads).toBe(0)
  })
}
