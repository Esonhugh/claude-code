import assert from 'node:assert/strict'
import test from 'node:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

test('with nonessential traffic off, fast mode reads unavailable like 2.1.311 instead of staying pending', async () => {
  const saved = { ...process.env }
  try {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.CLAUDE_CODE_DISABLE_FAST_MODE
    delete process.env.CLAUDE_CODE_USE_OPENAI
    ;(await import('../bootstrap/state.js')).setIsInteractive(true)
    const { getFastModeUnavailableReason, prefetchFastModeStatus } =
      await import('./fastMode.js')
    await prefetchFastModeStatus()
    assert.equal(getFastModeUnavailableReason(), 'Fast mode is currently unavailable')
  } finally {
    process.env = saved
  }
})
