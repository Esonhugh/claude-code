import { expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

// Auto mode is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_AUTO_MODE_SAFETY_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('auto mode safety checks (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-auto-mode-safety-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', '--timeout', '30000', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: {
          ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key',
          DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
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
  }, 180_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { setSessionSettingsCache } = await import('../settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })

  // By default the classifier approves anything; only a non-approvable safety check keeps it out.
  let classifierCalls = 0
  const reply = '<block>no</block>'
  mock.module('../sideQuery.js', () => ({
    sideQuery: async () => {
      classifierCalls++
      return {
        id: 'msg_classifier', type: 'message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }
    },
  }))

  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { BashTool } = await import('../../tools/BashTool/BashTool.js')
  const { FileReadTool } = await import('../../tools/FileReadTool/FileReadTool.js')
  const { FileWriteTool } = await import('../../tools/FileWriteTool/FileWriteTool.js')
  const { hasPermissionsToUseTool } = await import('./permissions.js')

  function autoContext(permission: Partial<ToolPermissionContext> = {}) {
    const initial = getDefaultAppState()
    const state = {
      ...initial,
      toolPermissionContext: {
        ...initial.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true, ...permission,
      } as ToolPermissionContext,
    }
    return {
      getAppState: () => state,
      setAppState: () => {},
      abortController: new AbortController(),
      messages: [],
      options: { isNonInteractiveSession: false, tools: [BashTool, FileReadTool, FileWriteTool] },
    } as unknown as ToolUseContext
  }

  const read = (file_path: string, permission?: Partial<ToolPermissionContext>) => hasPermissionsToUseTool(
    FileReadTool, { file_path }, autoContext(permission), { message: { id: 'msg_test' } } as never, `read-${file_path}`,
  )

  test('like official 2.1.292, the auto mode classifier cannot approve a UNC path read', async () => {
    for (const path of ['//attacker.example/share/secret.txt', '\\\\attacker.example\\share\\secret.txt']) {
      classifierCalls = 0
      const result = await read(path)
      expect(result.behavior).toBe('ask')
      expect(result.decisionReason).toMatchObject({ type: 'safetyCheck', classifierApprovable: false })
      expect(classifierCalls).toBe(0)
    }
  })

  test('the auto mode classifier cannot approve a read through a Windows short name', async () => {
    classifierCalls = 0
    const result = await read(join(tmpdir(), 'SETTIN~1', 'settings.json'))
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck', classifierApprovable: false })
    expect(classifierCalls).toBe(0)
  })

  test('a UNC path read is denied where no one can be asked', async () => {
    classifierCalls = 0
    const result = await read('//attacker.example/share/secret.txt', { shouldAvoidPermissionPrompts: true })
    expect(result.behavior).toBe('deny')
    expect(classifierCalls).toBe(0)
  })
}
