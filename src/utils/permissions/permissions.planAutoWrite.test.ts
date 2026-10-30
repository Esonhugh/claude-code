import { expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

// Plan mode with auto semantics must not take the "would be allowed in
// acceptEdits" shortcut: that shortcut lets a Write in the cwd through while
// planning. Official 2.1.311 skips it in plan mode (`mr=Oe==="plan"`).
// The classifier path needs TRANSCRIPT_CLASSIFIER, so this runs in a child.
const childFlag = 'CLAUDE_CODE_PLAN_AUTO_WRITE_TEST_CHILD'

if (process.env[childFlag] === undefined) {
  test('plan mode with auto active sends cwd writes to the classifier (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-plan-auto-write-'))
    const env = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(key),
    ))
    try {
      const child = Bun.spawn([process.execPath, 'test', '--feature=TRANSCRIPT_CLASSIFIER', '--timeout', '30000', import.meta.path], {
        cwd: join(import.meta.dir, '../../..'),
        env: {
          ...env, [childFlag]: '1', HOME: home, CLAUDE_CONFIG_DIR: home,
          ANTHROPIC_API_KEY: 'test-only-not-a-real-key', ANTHROPIC_MODEL: 'claude-opus-5-5',
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
  }, 120_000)
} else {
  ;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
  const { setSessionSettingsCache } = await import('../settings/settingsCache.js')
  setSessionSettingsCache({ settings: {}, errors: [] })

  let classifierCalls = 0
  mock.module('../sideQuery.js', () => ({
    sideQuery: async (options: { model: string }) => {
      classifierCalls++
      return {
        id: 'msg_classifier', type: 'message', role: 'assistant', model: options.model,
        content: [{ type: 'text', text: '<severity>90</severity>' }],
        stop_reason: 'stop_sequence', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }
    },
  }))

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cc-plan-auto-work-')))
  const { setCwdState, setOriginalCwd } = await import('../../bootstrap/state.js')
  setOriginalCwd(work)
  setCwdState(work)
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { FileWriteTool } = await import('../../tools/FileWriteTool/FileWriteTool.js')
  const { hasPermissionsToUseTool } = await import('./permissions.js')
  const { setAutoModeActive } = await import('./autoModeState.js')

  const check = async (mode: 'plan' | 'auto') => {
    const initial = getDefaultAppState()
    const state = {
      ...initial,
      toolPermissionContext: { ...initial.toolPermissionContext, mode, prePlanMode: 'acceptEdits', isAutoModeAvailable: true } as ToolPermissionContext,
    }
    const context = {
      getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), messages: [],
      readFileState: new Map(),
      options: { isNonInteractiveSession: false, tools: [FileWriteTool] },
    } as unknown as ToolUseContext
    classifierCalls = 0
    setAutoModeActive(true)
    const result = await hasPermissionsToUseTool(
      FileWriteTool, { file_path: join(work, 'plan.txt'), content: 'x\n' }, context,
      { message: { id: 'msg_test' } } as never, 'plan-auto-write',
    )
    return { behavior: result.behavior, classifierCalls }
  }

  test('a cwd Write in plan mode is not allowed by the acceptEdits shortcut', async () => {
    const plan = await check('plan')
    expect(plan.behavior).not.toBe('allow')
    expect(plan.classifierCalls).toBeGreaterThan(0)
  })

  test('auto mode still takes the acceptEdits shortcut for a cwd Write', async () => {
    expect(await check('auto')).toEqual({ behavior: 'allow', classifierCalls: 0 })
  })
}
