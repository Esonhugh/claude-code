import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childSource = `
  import assert from 'node:assert/strict'
  const { z } = await import(${JSON.stringify(import.meta.resolve('zod/v4'))})
  const state = await import(${JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href)})
  const { enableConfigs } = await import(${JSON.stringify(new URL('../../utils/config.ts', import.meta.url).href)})
  state.setOriginalCwd(process.cwd())
  enableConfigs()
  const { getDefaultAppState } = await import(${JSON.stringify(new URL('../../state/AppStateStore.ts', import.meta.url).href)})
  const { createModToolHost } = await import(${JSON.stringify(new URL('./toolHost.ts', import.meta.url).href)})
  const scenario = JSON.parse(process.env.MODS_PERMISSION_REASON_CASE)
  const observed = { checks: 0, calls: 0, prompts: 0, hooks: 0 }
  const tool = {
    name: 'ReasonFixture', inputSchema: z.object({ value: z.string() }),
    checkPermissions: async input => {
      assert.deepEqual(input, { value: 'probe' })
      observed.checks++
      return scenario.native
    },
    call: async () => { observed.calls++; throw new Error('check must not execute') },
  }
  let app = getDefaultAppState()
  app = { ...app, toolPermissionContext: { ...app.toolPermissionContext,
    mode: scenario.mode ?? 'default', isBypassPermissionsModeAvailable: scenario.mode === 'plan' } }
  const context = {
    options: { tools: [tool], mcpClients: [], isNonInteractiveSession: true },
    abortController: new AbortController(), messages: [],
    getAppState: () => app,
    setAppState: updater => { app = typeof updater === 'function' ? updater(app) : updater },
    modsSnapshot: { hasHooks: () => true,
      dispatch: async () => { observed.hooks++; throw new Error('check must not run hooks') } },
  }
  const host = createModToolHost(context, async () => {
    observed.prompts++; throw new Error('check must not prompt')
  })
  assert.deepEqual(await host.check({ tool: tool.name, input: { value: 'probe' } },
    new AbortController().signal), scenario.expected)
  assert.deepEqual(observed, { checks: 1, calls: 0, prompts: 0, hooks: 0 })
`

const rule = { source: 'userSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'ReasonFixture' } }
const cases = [
  { label: 'bypass mode', mode: 'bypassPermissions', native: { behavior: 'passthrough' }, expected: { decision: 'allow' } },
  { label: 'plan with bypass available', mode: 'plan', native: { behavior: 'passthrough' }, expected: { decision: 'allow' } },
  { label: 'allow reason', native: { behavior: 'allow', decisionReason: { type: 'other', reason: 'Actual allowance' } }, expected: { decision: 'allow', reason: 'Actual allowance' } },
  { label: 'allow rule', native: { behavior: 'allow', decisionReason: { type: 'rule', rule } }, expected: { decision: 'allow', rule: 'ReasonFixture' } },
  { label: 'ask message', native: { behavior: 'ask', message: 'Actual approval request' }, expected: { decision: 'ask', reason: 'Actual approval request' } },
  { label: 'deny in bypass mode', mode: 'bypassPermissions', native: { behavior: 'deny', message: 'Actual veto' }, expected: { decision: 'deny', reason: 'Actual veto' } },
  { label: 'safety ask in bypass mode', mode: 'bypassPermissions', native: { behavior: 'ask', message: 'Actual safety request', decisionReason: { type: 'safetyCheck', reason: 'Safety metadata' } }, expected: { decision: 'ask', reason: 'Actual safety request' } },
  { label: 'empty allow reason', native: { behavior: 'allow', decisionReason: { type: 'other', reason: '' } }, expected: { decision: 'allow' } },
  { label: 'empty ask message', native: { behavior: 'ask', message: '' }, expected: { decision: 'ask' } },
  { label: 'empty deny message', native: { behavior: 'deny', message: '' }, expected: { decision: 'deny' } },
] as const

for (const scenario of cases) {
  test(`public tool.check reason: ${scenario.label}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mods-permission-reason-')))
    try {
      const child = Bun.spawn([process.execPath, '--eval', childSource], {
        cwd: root,
        env: {
          PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: 'production',
          CLAUDE_CONFIG_DIR: join(root, 'config'), ANTHROPIC_API_KEY: 'mods-permission-reason-unused-key',
          MODS_PERMISSION_REASON_CASE: JSON.stringify(scenario),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
