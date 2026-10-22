import assert from 'node:assert/strict'
import test from 'node:test'
import axios from 'axios'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const root = mkdtempSync(join(tmpdir(), 'metrics-opt-out-'))
process.env.HOME = root
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
const { enableConfigs } = await import('../../utils/config.js')
enableConfigs()

const { checkMetricsEnabled, _clearMetricsEnabledCacheForTesting } =
  await import('./metricsOptOut.js')
const { isAnalyticsDisabled } = await import('../analytics/config.js')

async function withOptIn(
  env: Record<string, string>,
  run: (calls: string[]) => Promise<void>,
) {
  const saved = { ...process.env }
  const calls: string[] = []
  const originalGet = axios.get
  axios.get = (async (url: string) => {
    calls.push(url)
    return { data: { metrics_logging_enabled: true } }
  }) as typeof axios.get
  try {
    for (const key of [
      'DISABLE_TELEMETRY',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ])
      delete process.env[key]
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_CODE_ENABLE_ANTHROPIC_TELEMETRY = '1'
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
    Object.assign(process.env, env)
    _clearMetricsEnabledCacheForTesting()
    await run(calls)
  } finally {
    axios.get = originalGet
    process.env = saved
  }
}

test('DISABLE_TELEMETRY stops the metrics opt-out check even when Anthropic telemetry is opted in', async () => {
  await withOptIn({ DISABLE_TELEMETRY: '1' }, async calls => {
    assert.deepEqual(await checkMetricsEnabled(), {
      enabled: false,
      hasError: false,
    })
    assert.deepEqual(calls, [])
  })
})

test('opted-in analytics stays off when ANTHROPIC_BASE_URL is a third-party gateway', async () => {
  await withOptIn(
    { ANTHROPIC_BASE_URL: 'https://gateway.example.com' },
    async calls => {
      assert.equal(isAnalyticsDisabled(), true)
      assert.deepEqual(await checkMetricsEnabled(), {
        enabled: false,
        hasError: false,
      })
      assert.deepEqual(calls, [])
    },
  )
})

test('opted-in analytics stays on for the first-party API', async () => {
  await withOptIn({}, async () => {
    assert.equal(isAnalyticsDisabled(), false)
  })
})
