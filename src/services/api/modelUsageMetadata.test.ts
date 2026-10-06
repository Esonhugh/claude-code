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
  const { addToTotalSessionCost, restoreSessionCosts } = await import(${JSON.stringify(new URL('../../cost-tracker.ts', import.meta.url).href)})
  const { calculateUSDCost } = await import(${JSON.stringify(new URL('../../utils/modelCost.ts', import.meta.url).href)})
  const { captureSessionCostState } = await import(${JSON.stringify(new URL('../../utils/sessionCostState.ts', import.meta.url).href)})
  const { ModelUsageSchema } = await import(${JSON.stringify(new URL('../../entrypoints/sdk/coreSchemas.ts', import.meta.url).href)})
  const { EMPTY_USAGE } = await import(${JSON.stringify(new URL('./emptyUsage.ts', import.meta.url).href)})
  const scenario = process.env.MODEL_METADATA_SCENARIO
  const model = 'claude-sonnet-4-6'
  const usage = { ...EMPTY_USAGE, input_tokens: 10, output_tokens: 5 }
  const record = (name = model) => addToTotalSessionCost(calculateUSDCost(name, usage), usage, name)
  state.resetCostState()
  if (scenario === 'canonical') {
    const raw = 'us.anthropic.claude-sonnet-4-6-v1:0'
    record(raw)
    const value = state.getUsageForModel(raw)
    assert.equal(value.canonicalModel, model)
    assert.equal(value.provider, 'firstParty')
    assert.equal(value.costBasis, 'list')
    assert.equal(value.costUSD, calculateUSDCost(raw, usage))
    assert.equal(value.contextWindow, 200000)
    assert.equal(value.maxOutputTokens, 32000)
    assert.equal(ModelUsageSchema().parse(value).canonicalModel, model)
  } else if (scenario === 'unknown') {
    record('custom-unpriced-model')
    const value = state.getUsageForModel('custom-unpriced-model')
    assert.equal(value.canonicalModel, 'custom-unpriced-model')
    assert.equal(value.provider, 'firstParty')
    assert.equal(value.costBasis, 'unknown')
    assert.equal(state.hasUnknownModelCost(), true)
    assert.equal(value.costUSD, calculateUSDCost('custom-unpriced-model', usage))
  } else if (scenario === 'schema') {
    const old = { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.01,
      contextWindow: 200000, maxOutputTokens: 32000 }
    assert.deepEqual(ModelUsageSchema().parse(old), old)
    const metadata = { ...old, canonicalModel: model, provider: 'gateway', costBasis: 'managed' }
    assert.deepEqual(ModelUsageSchema().parse(metadata), metadata)
    assert.equal(ModelUsageSchema().safeParse({ ...metadata, costBasis: 'catalog' }).success, false)
    for (const key of ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens',
      'cacheCreationInputTokens', 'webSearchRequests', 'contextWindow', 'maxOutputTokens']) {
      assert.equal(ModelUsageSchema().safeParse({ ...metadata, [key]: 1.5 }).success, false, key)
    }
  } else if (scenario === 'restore') {
    record()
    const snapshot = captureSessionCostState()
    assert.equal(snapshot.modelUsage[model].canonicalModel, undefined)
    assert.equal(snapshot.modelUsage[model].provider, undefined)
    assert.equal(snapshot.modelUsage[model].costBasis, undefined)
    const prior = snapshot.modelUsage[model].costUSD
    state.resetCostState()
    state.setSdkBetas(['context-1m-2025-08-07'])
    assert.equal(restoreSessionCosts({ sessionId: state.getSessionId(), costState: snapshot }), true)
    const restored = state.getUsageForModel(model)
    assert.equal(restored.canonicalModel, undefined)
    assert.equal(restored.contextWindow, 1000000)
    assert.equal(restored.maxOutputTokens, 32000)
    record()
    const updated = state.getUsageForModel(model)
    assert.equal(updated.canonicalModel, model)
    assert.equal(updated.provider, 'firstParty')
    assert.equal(updated.costBasis, 'list')
    assert.equal(updated.costUSD, prior + calculateUSDCost(model, usage))
    assert.equal(updated.inputTokens, 20)
  } else {
    record()
    const value = state.getUsageForModel(model)
    assert.equal(value.provider, scenario.slice('provider-'.length))
    assert.equal(value.costBasis, 'list')
    assert.equal(ModelUsageSchema().parse(value).provider, value.provider)
  }
`

test.each(['canonical', 'unknown', 'schema', 'restore',
  'provider-firstParty', 'provider-bedrock', 'provider-vertex', 'provider-foundry', 'provider-openai'])(
  'model usage metadata follows the production accounting path: %s',
  async scenario => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'model-usage-metadata-')))
    try {
      const provider = scenario.startsWith('provider-') ? scenario.slice('provider-'.length) : 'firstParty'
      const child = Bun.spawn([process.execPath, '--eval', childSource], {
        cwd: root,
        env: {
          PATH: process.env.PATH, HOME: root, TMPDIR: root,
          CLAUDE_CONFIG_DIR: join(root, 'config'), NODE_ENV: 'production',
          ANTHROPIC_API_KEY: 'model-metadata-unused-key',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
          MODEL_METADATA_SCENARIO: scenario,
          ...(provider !== 'firstParty' && { ['CLAUDE_CODE_USE_' + provider.toUpperCase()]: '1' }),
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
  },
)
