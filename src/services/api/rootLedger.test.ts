import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childSource = `
  import assert from 'node:assert/strict'
  const state = await import(${JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href)})
  const { enableConfigs } = await import(${JSON.stringify(new URL('../../utils/config.ts', import.meta.url).href)})
  state.setOriginalCwd(process.cwd())
  enableConfigs()
  const { runWithAgentContext, getAgentContext } = await import(${JSON.stringify(new URL('../../utils/agentContext.ts', import.meta.url).href)})
  const { addToTotalSessionCost } = await import(${JSON.stringify(new URL('../../cost-tracker.ts', import.meta.url).href)})
  const { captureSessionCostState } = await import(${JSON.stringify(new URL('../../utils/sessionCostState.ts', import.meta.url).href)})
  const { EMPTY_USAGE } = await import(${JSON.stringify(new URL('./emptyUsage.ts', import.meta.url).href)})
  state.resetCostState()
  const id = state.getSessionId()
  let arrivals = 0
  const bothStarted = Promise.withResolvers()
  const agents = ['child-A', 'child-B']
  await Promise.all(agents.map((agentId, index) => runWithAgentContext({ agentId, agentType: 'subagent', parentSessionId: id }, async () => {
    assert.equal(getAgentContext().agentId, agentId)
    assert.equal(state.getSessionId(), id)
    if (++arrivals === 2) bothStarted.resolve()
    await bothStarted.promise
    assert.equal(getAgentContext().agentId, agentId)
    addToTotalSessionCost(index + 1, { ...EMPTY_USAGE, input_tokens: (index + 1) * 10,
      output_tokens: index + 1, output_tokens_details: { thinking_tokens: index + 1 } }, 'claude-sonnet-4-6')
  })))
  assert.equal(getAgentContext(), undefined)
  assert.equal(state.getSessionId(), id)
  assert.equal(state.getTotalCostUSD(), 3)
  const value = state.getUsageForModel('claude-sonnet-4-6')
  assert.equal(value.inputTokens, 30)
  assert.equal(value.outputTokens, 3)
  assert.equal(value.thinkingTokens, 3)
  assert.equal(value.costUSD, 3)
  const snapshot = captureSessionCostState()
  assert.equal(snapshot.sessionId, id)
  assert.equal(snapshot.totalCostUSD, 3)
  assert.equal(snapshot.modelUsage['claude-sonnet-4-6'].inputTokens, 30)
`

test('concurrent subagent contexts contribute to their shared root session ledger', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'root-ledger-')))
  try {
    const child = Bun.spawn([process.execPath, '--eval', childSource], {
      cwd: root,
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), NODE_ENV: 'production',
        ANTHROPIC_API_KEY: 'root-ledger-unused-key',
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
