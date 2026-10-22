import { expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

// Auto mode is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_STALE_CLASSIFIER_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('classifier verdict after a mode switch (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-stale-classifier-'))
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

  // The classifier's model call; the test switches the mode while it is in flight.
  let duringClassifier: () => void = () => {}
  let reply = '<block>no</block>'
  let classifierCalls = 0
  mock.module('../sideQuery.js', () => ({
    sideQuery: async () => {
      classifierCalls++
      duringClassifier()
      return {
        id: 'msg_classifier', type: 'message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }
    },
  }))

  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { BashTool } = await import('../../tools/BashTool/BashTool.js')
  const { hasPermissionsToUseTool } = await import('./permissions.js')

  function autoContext() {
    const initial = getDefaultAppState()
    let state = {
      ...initial,
      toolPermissionContext: { ...initial.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true } as ToolPermissionContext,
    }
    const ctx = {
      getAppState: () => state,
      setAppState: (update: (prev: typeof state) => typeof state) => { state = update(state) },
      abortController: new AbortController(),
      messages: [],
      options: { isNonInteractiveSession: false, tools: [BashTool] },
    } as unknown as ToolUseContext
    const switchTo = (mode: ToolPermissionContext['mode']) => {
      state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode } }
    }
    return { ctx, switchTo }
  }

  const check = (ctx: ToolUseContext, id: string) => hasPermissionsToUseTool(
    BashTool, { command: 'python3 mk.py c1' }, ctx, { message: { id: 'msg_test' } } as never, id,
  )

  test('auto still applies the classifier allow when the mode did not change', async () => {
    const { ctx } = autoContext()
    duringClassifier = () => {}
    reply = '<block>no</block>'
    const result = await check(ctx, 'unchanged')
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({ type: 'classifier' })
  })

  test('switching to default while the classifier runs asks instead of applying its allow', async () => {
    const { ctx, switchTo } = autoContext()
    duringClassifier = () => switchTo('default')
    reply = '<block>no</block>'
    const calls = classifierCalls
    const result = await check(ctx, 'stale-allow')
    expect(classifierCalls).toBe(calls + 1)
    expect(result.behavior).toBe('ask')
  })

  test('switching to default while the classifier runs does not apply its block either', async () => {
    const { ctx, switchTo } = autoContext()
    duringClassifier = () => switchTo('default')
    reply = '<block>yes</block><reason>blocked</reason>'
    const result = await check(ctx, 'stale-block')
    expect(result.behavior).toBe('ask')
  })
}
