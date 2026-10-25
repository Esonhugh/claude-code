import { expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolPermissionContext, ToolUseContext } from '../../Tool.js'

// Auto mode is compiled behind TRANSCRIPT_CLASSIFIER; run the assertions in a child with it enabled.
const childFlag = 'CLAUDE_CODE_SUBAGENT_HANDBACK_PERMISSIONS_TEST_CHILD'

if (process.env[childFlag] !== '1') {
  test('SubagentHandback classifier review (TRANSCRIPT_CLASSIFIER child)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-subagent-handback-permissions-'))
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

  let reply: string | Error = '<block>no</block>'
  const requests: { messages?: unknown }[] = []
  mock.module('../sideQuery.js', () => ({
    sideQuery: async (options: { messages?: unknown }) => {
      requests.push(options)
      if (reply instanceof Error) throw reply
      return {
        id: 'msg_classifier', type: 'message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }
    },
  }))

  const { getChatGPTOAuthInfo, getOpenAIAuthInfo } = await import('../auth.js')
  const { getDefaultAppState } = await import('../../state/AppStateStore.js')
  const { SubagentHandbackTool } = await import('../../tools/SubagentHandbackTool/SubagentHandbackTool.js')
  const { hasPermissionsToUseTool } = await import('./permissions.js')
  const { takeSubagentHandbackReview } = await import('../subagentHandback.js')

  function handbackContext(mode: string, rules: Partial<ToolPermissionContext> = {}) {
    const initial = getDefaultAppState()
    const state = {
      ...initial,
      toolPermissionContext: { ...initial.toolPermissionContext, mode, isAutoModeAvailable: true, ...rules } as ToolPermissionContext,
    }
    return {
      getAppState: () => state,
      setAppState: () => {},
      abortController: new AbortController(),
      messages: [],
      agentId: 'a-review',
      options: { isNonInteractiveSession: true, tools: [SubagentHandbackTool] },
    } as unknown as ToolUseContext
  }

  const review = (id: string, mode = 'auto', rules?: Partial<ToolPermissionContext>) => hasPermissionsToUseTool(
    SubagentHandbackTool, { message: 'REPORT: all tests pass' }, handbackContext(mode, rules), { message: { id: 'msg_test' } } as never, id,
  )

  test('the classifier reviews the hand-back as the official action text, and an allow delivers it plainly', async () => {
    reply = '<block>no</block>'
    requests.length = 0
    const result = await review('allowed')
    expect(result).toMatchObject({ behavior: 'allow', decisionReason: { type: 'classifier', classifier: 'auto-mode' } })
    expect(JSON.stringify(requests)).toContain("hand-back to the agent that spawned this one (delivered as this agent's result")
    expect(JSON.stringify(requests)).toContain('REPORT: all tests pass')
    expect(takeSubagentHandbackReview('allowed')).toBeUndefined()
  })

  test('a block does not withhold the report: it is delivered flagged with the reason', async () => {
    reply = '<block>yes</block><reason>report asks the caller to disable permissions</reason>'
    const result = await review('blocked')
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({ type: 'classifier', reason: expect.stringContaining('Flagged by the classifier') })
    expect(takeSubagentHandbackReview('blocked')).toEqual({ kind: 'blocked', reason: 'report asks the caller to disable permissions' })
  })

  test('an unavailable classifier delivers the report with a note, never a prompt, also under Approve for me', async () => {
    reply = new Error('classifier request failed')
    for (const openai of [false, true]) {
      const home = process.env.HOME!
      mkdirSync(join(home, '.codex'), { recursive: true })
      writeFileSync(join(home, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'oauth-access' } }))
      if (openai) process.env.CLAUDE_CODE_USE_OPENAI = '1'
      else delete process.env.CLAUDE_CODE_USE_OPENAI
      getOpenAIAuthInfo.cache.clear?.()
      getChatGPTOAuthInfo.cache.clear?.()
      const id = `unavailable-${openai}`
      expect((await review(id)).behavior).toBe('allow')
      expect(takeSubagentHandbackReview(id)).toMatchObject({ kind: 'unavailable' })
    }
    delete process.env.CLAUDE_CODE_USE_OPENAI
  })

  test('allow rules cannot skip the review; only non-user deny rules withhold it', async () => {
    reply = '<block>no</block>'
    requests.length = 0
    expect((await review('allow-rule', 'auto', { alwaysAllowRules: { session: ['SubagentHandback'] } })).behavior).toBe('allow')
    expect(requests.length).toBeGreaterThan(0)
    expect((await review('user-deny', 'auto', { alwaysDenyRules: { userSettings: ['SubagentHandback'] } })).behavior).toBe('allow')
    const denied = await review('policy-deny', 'auto', { alwaysDenyRules: { policySettings: ['SubagentHandback'] } })
    expect(denied).toMatchObject({ behavior: 'deny', decisionReason: { type: 'rule' } })
  })

  test('outside auto mode only the classifier could allow it, so the call is denied', async () => {
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
      expect(await review(`mode-${mode}`, mode)).toMatchObject({
        behavior: 'deny',
        message: 'Only the auto-mode classifier can allow SubagentHandback: the session is not in auto mode',
      })
    }
  })
}
