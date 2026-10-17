import { expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const childSource = `
  import assert from 'node:assert/strict'
  const { updateUsage, accumulateUsage } = await import(${JSON.stringify(new URL('./claude.ts', import.meta.url).href)})
  const { EMPTY_USAGE } = await import(${JSON.stringify(new URL('./emptyUsage.ts', import.meta.url).href)})
  const state = await import(${JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href)})
  const { enableConfigs } = await import(${JSON.stringify(new URL('../../utils/config.ts', import.meta.url).href)})
  state.setOriginalCwd(process.cwd())
  enableConfigs()
  const { addToTotalSessionCost } = await import(${JSON.stringify(new URL('../../cost-tracker.ts', import.meta.url).href)})
  const { captureSessionCostState } = await import(${JSON.stringify(new URL('../../utils/sessionCostState.ts', import.meta.url).href)})
  const { calculateUSDCost } = await import(${JSON.stringify(new URL('../../utils/modelCost.ts', import.meta.url).href)})
  const { ModelUsageSchema } = await import(${JSON.stringify(new URL('../../entrypoints/sdk/coreSchemas.ts', import.meta.url).href)})
  const scenario = process.env.THINKING_USAGE_SCENARIO
  const model = 'claude-sonnet-4-6'
  const sample = { ...EMPTY_USAGE, input_tokens: 20, output_tokens: 10, output_tokens_details: { thinking_tokens: 6 } }
  if (scenario === 'empty') {
    assert.deepEqual(EMPTY_USAGE.output_tokens_details, { thinking_tokens: 0 })
    assert.deepEqual(updateUsage(EMPTY_USAGE, { output_tokens: 5 }).output_tokens_details, { thinking_tokens: 0 })
  } else if (scenario === 'stream') {
    const before = JSON.stringify(sample)
    assert.equal(updateUsage(sample, { output_tokens: 12, output_tokens_details: { thinking_tokens: 9 } }).output_tokens_details.thinking_tokens, 9)
    assert.equal(updateUsage(sample, { output_tokens: 12 }).output_tokens_details.thinking_tokens, 6)
    assert.equal(updateUsage(sample, { output_tokens: 12, output_tokens_details: null }).output_tokens_details.thinking_tokens, 6)
    assert.equal(updateUsage(sample, { output_tokens: 12, output_tokens_details: { thinking_tokens: 0 } }).output_tokens_details.thinking_tokens, 0)
    assert.equal(JSON.stringify(sample), before)
  } else if (scenario === 'accumulate') {
    const second = { ...sample, output_tokens: 5, output_tokens_details: { thinking_tokens: 4 } }
    const result = accumulateUsage(sample, second)
    assert.equal(result.output_tokens, 15)
    assert.equal(result.output_tokens_details.thinking_tokens, 10)
    assert.equal(sample.output_tokens_details.thinking_tokens, 6)
    assert.equal(second.output_tokens_details.thinking_tokens, 4)
  } else {
    state.resetCostState()
    const saved = { inputTokens: 20, outputTokens: 10, thinkingTokens: 6, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 1.25, contextWindow: 200000, maxOutputTokens: 32000 }
    state.setCostStateForRestore({ totalCostUSD: 1.25, totalAPIDuration: 0, totalAPIDurationWithoutRetries: 0,
      totalToolDuration: 0, totalLinesAdded: 0, totalLinesRemoved: 0, lastDuration: 0, modelUsage: { [model]: saved } })
    const incoming = { ...EMPTY_USAGE, input_tokens: 10, output_tokens: 5, output_tokens_details: { thinking_tokens: 4 } }
    const price = calculateUSDCost(model, incoming)
    assert.equal(price, calculateUSDCost(model, { ...incoming, output_tokens_details: { thinking_tokens: 0 } }))
    assert.equal(addToTotalSessionCost(price, incoming, model), price)
    const usage = state.getModelUsage()[model]
    assert.equal(usage.thinkingTokens, 10)
    assert.equal(usage.outputTokens, 15)
    assert.equal(usage.costUSD, 1.25 + price)
    assert.equal(state.getTotalCostUSD(), 1.25 + price)
    assert.equal(captureSessionCostState().modelUsage[model].thinkingTokens, 10)
    assert.equal(ModelUsageSchema().parse(usage).thinkingTokens, 10)
    addToTotalSessionCost(0, { ...incoming, output_tokens_details: undefined }, model)
    assert.equal(state.getModelUsage()[model].thinkingTokens, 10)
  }
`

test.each(['empty', 'stream', 'accumulate', 'ledger'])(
  'thinking usage passes through the production accounting chain: %s',
  async scenario => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'thinking-usage-')))
    try {
      const child = Bun.spawn([process.execPath, '--eval', childSource], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          NODE_ENV: 'production',
          ANTHROPIC_API_KEY: 'thinking-unused-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          THINKING_USAGE_SCENARIO: scenario,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`${stdout}\n${stderr}`)
      expect(code).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
