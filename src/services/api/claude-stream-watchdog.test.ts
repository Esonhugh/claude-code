import { afterEach, expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const { getStreamIdleWatchdogConfig } = await import('./claude.js')

const saved = {
  enabled: process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
  timeout: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
}

afterEach(() => {
  for (const [key, value] of [
    ['CLAUDE_ENABLE_STREAM_WATCHDOG', saved.enabled],
    ['CLAUDE_STREAM_IDLE_TIMEOUT_MS', saved.timeout],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('stream idle watchdog is on by default with a 5 minute window', () => {
  delete process.env.CLAUDE_ENABLE_STREAM_WATCHDOG
  delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
  expect(getStreamIdleWatchdogConfig()).toEqual({
    enabled: true,
    idleTimeoutMs: 300_000,
  })
})

test('CLAUDE_ENABLE_STREAM_WATCHDOG=0 opts out', () => {
  for (const value of ['0', 'false', 'off']) {
    process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = value
    expect(getStreamIdleWatchdogConfig().enabled).toBe(false)
  }
  process.env.CLAUDE_ENABLE_STREAM_WATCHDOG = '1'
  expect(getStreamIdleWatchdogConfig().enabled).toBe(true)
})

test('CLAUDE_STREAM_IDLE_TIMEOUT_MS can only lengthen the idle window', () => {
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '90000'
  expect(getStreamIdleWatchdogConfig().idleTimeoutMs).toBe(300_000)
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '600000'
  expect(getStreamIdleWatchdogConfig().idleTimeoutMs).toBe(600_000)
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = 'nope'
  expect(getStreamIdleWatchdogConfig().idleTimeoutMs).toBe(300_000)
})
