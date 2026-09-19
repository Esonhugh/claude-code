#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { spyOn } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
process.env.NODE_ENV = 'test'
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
process.env.CLAUDE_CODE_USE_OPENAI = '1'
process.env.ANTHROPIC_API_KEY = 'test-key'

let fetchCount = 0
let detailsFetchCount = 0
let consumeCount = 0
let failDetails = false
let omitDetails = false
let usageSource: 'chatgpt' | 'claude' = 'chatgpt'
const resetCredit = {
  id: 'fixture-credit',
  reset_type: 'codex_rate_limits',
  status: 'available',
  granted_at: '2026-06-17T00:00:00Z',
  expires_at: '2026-07-17T00:00:00Z',
  redeemed_at: null as string | null,
  title: 'Full reset (Weekly + 5 hr)',
}
const previousReset = {
  ...resetCredit,
  id: 'previous-credit',
  status: 'redeemed',
  expires_at: null,
  redeemed_at: '2026-06-18T12:30:00Z',
}
const formatTime = (value: string) => new Date(value).toLocaleString('en-US', {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZoneName: 'short',
})
const keybindingCalls: Array<{
  action: string
  handler: () => void | false
  context?: string
  isActive?: boolean
}> = []

const keybindingModule = await import('../../keybindings/useKeybinding.js')
const usageModule = await import('../../services/api/usage.js')
const extraUsageModule = await import('../../commands/extra-usage/index.js')
const overageModule = await import('../LogoV2/OverageCreditUpsell.js')
const mocks = [
  spyOn(keybindingModule, 'useKeybinding').mockImplementation((
    action: string,
    handler: () => void | false,
    options: { context?: string; isActive?: boolean } = {},
  ) => {
    keybindingCalls.push({ action, handler, ...options })
  }),
  spyOn(keybindingModule, 'useKeybindings').mockImplementation(() => {}),
  spyOn(extraUsageModule.extraUsage, 'isEnabled').mockReturnValue(false),
  spyOn(overageModule, 'isEligibleForOverageCreditGrant').mockReturnValue(false),
  spyOn(overageModule, 'OverageCreditUpsell').mockImplementation(() => null),
  spyOn(usageModule, 'fetchUtilization').mockImplementation(async () => {
    fetchCount += 1
    return {
      source: usageSource,
      chatgpt_limits: [{ title: 'ChatGPT Codex weekly usage', limit: { utilization: 25, resets_at: null } }],
      rate_limit_reset_credits: { available_count: fetchCount === 1 ? 1 : 0 },
    }
  }),
  spyOn(usageModule, 'fetchRateLimitResetCredits').mockImplementation(async () => {
    detailsFetchCount += 1
    if (failDetails) throw new Error('reset details offline')
    if (omitDetails) return null
    return {
      available_count: fetchCount === 1 ? 2 : 0,
      total_earned_count: 3,
      credits: fetchCount === 1
        ? [resetCredit, previousReset, { ...resetCredit, id: 'unknown-credit', status: 'future_status', granted_at: 'invalid', expires_at: undefined }]
        : fetchCount === 2
          ? [{ ...resetCredit, status: 'redeemed', redeemed_at: '2026-06-19T10:00:00Z' }, previousReset, { ...previousReset, id: 'missing-time', redeemed_at: null }]
          : [],
    }
  }),
  spyOn(usageModule, 'consumeRateLimitResetCredit').mockImplementation(async () => {
    consumeCount += 1
    return { code: 'reset', windows_reset: 2 }
  }),
]

function getActiveKeybinding(action: string) {
  return keybindingCalls.findLast(
    call => call.action === action && call.isActive !== false,
  )
}

const { render, useInput } = await import('../../ink.js')
let backgroundInputCount = 0
function InputDriver() {
  useInput(() => { backgroundInputCount += 1 })
  return null
}
const instances = (await import('../../ink/instances.js')).default
const { Usage } = await import('./Usage.js')
const { KeybindingProvider } = await import('../../keybindings/KeybindingContext.js')
const { DEFAULT_BINDINGS } = await import('../../keybindings/defaultBindings.js')
const { parseBindings } = await import('../../keybindings/parser.js')

class TestStdout extends Writable {
  columns = 100
  rows = 40
  isTTY = false
  output = ''

  _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.output += chunk.toString()
    callback()
  }
}

class TestStdin extends Readable {
  isTTY = true
  isRaw = false

  _read() {}

  setRawMode(value: boolean) {
    this.isRaw = value
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }
}

function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) {
        resolve()
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(message))
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

const stdout = new TestStdout()
const stdin = new TestStdin()
const usageElement = <Usage />
const outputStream = stdout as unknown as NodeJS.WriteStream
const instance = await render(usageElement, {
  stdout: outputStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  patchConsole: false,
  exitOnCtrlC: false,
})
const flushUpdates = () => {
  instances.get(outputStream)?.pause()
  instances.get(outputStream)?.resume()
}

try {
  await waitFor(() => fetchCount === 1, 'initial usage request did not start')
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()

  const initialOutput = stripAnsi(stdout.output)
  assert.match(initialOutput, /█[^\n]* 25% used/)
  assert.equal(detailsFetchCount, 1)
  assert.match(initialOutput, /Reset: 2/)
  assert.match(initialOutput, /Total granted: 3/)
  assert.ok(initialOutput.includes(`Granted: ${formatTime(resetCredit.granted_at)}`))
  assert.ok(initialOutput.includes(`Expires: ${formatTime(resetCredit.expires_at)}`))
  assert.match(initialOutput, /Does not expire/)
  assert.match(initialOutput, /Granted: Unavailable/)
  assert.match(initialOutput, /Expires: Unavailable/)
  assert.match(initialOutput, /future_status/)
  assert.match(initialOutput, /Used reset history/)
  assert.ok(initialOutput.includes(`Used: ${formatTime(previousReset.redeemed_at)}`))
  assert.match(initialOutput, /History may be incomplete/)
  assert.equal(consumeCount, 0)

  const selectReset = getActiveKeybinding('select:next')
  assert.equal(selectReset?.context, 'Settings')
  assert.equal(selectReset?.isActive, true)
  selectReset?.handler()
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()

  const openConfirmation = getActiveKeybinding('settings:close')
  assert.ok(openConfirmation)
  assert.equal(openConfirmation.context, 'Settings')
  assert.equal(openConfirmation.isActive, true)
  openConfirmation.handler()
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()

  const confirmReset = getActiveKeybinding('confirm:yes')
  assert.ok(confirmReset)
  assert.equal(confirmReset.context, 'Confirmation')
  assert.equal(confirmReset.isActive, true)
  stdout.output = ''
  confirmReset.handler()
  assert.equal(confirmReset.handler(), false)

  await waitFor(
    () => consumeCount === 1 && fetchCount === 2,
    `reset was not consumed and refreshed (consume=${consumeCount}, fetch=${fetchCount})`,
  )
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()

  const output = stripAnsi(stdout.output)
  assert.match(output, /Usage reset\./)
  assert.match(output, /Reset: 0/)
  assert.equal(consumeCount, 1)
  assert.equal(fetchCount, 2)
  assert.equal(detailsFetchCount, 2)
  assert.ok(output.includes(`Used: ${formatTime('2026-06-19T10:00:00Z')}`))
  assert.match(output, /Used: Unavailable/)
  assert.ok(output.indexOf(`Used: ${formatTime('2026-06-19T10:00:00Z')}`) < output.indexOf(`Used: ${formatTime(previousReset.redeemed_at)}`))

  // Remount with a failed detail request: summary and usage must remain visible.
  failDetails = true
  stdout.output = ''
  keybindingCalls.length = 0
  instance.rerender(<Usage key="offline" />)
  await waitFor(() => detailsFetchCount === 3, 'detail failure was not requested')
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()
  const offlineOutput = stripAnsi(stdout.output)
  assert.match(offlineOutput, /ChatGPT Codex weekly usage/)
  assert.match(offlineOutput, /Reset: 0/)
  assert.match(offlineOutput, /Reset details unavailable/)
  const retry = getActiveKeybinding('settings:retry')
  assert.ok(retry)

  failDetails = false
  stdout.output = ''
  retry.handler()
  await waitFor(() => detailsFetchCount === 4, 'detail retry was not requested')
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()
  const retriedOutput = stripAnsi(stdout.output)
  assert.match(retriedOutput, /No used reset records returned/)
  assert.doesNotMatch(retriedOutput, /Reset details unavailable/)

  usageSource = 'claude'
  stdout.output = ''
  instance.rerender(<Usage key="claude" />)
  await waitFor(() => fetchCount === 5, 'Claude usage was not requested')
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()
  assert.equal(detailsFetchCount, 4)
  assert.doesNotMatch(stripAnsi(stdout.output), /Reset:|Used reset history/)
  assert.equal(consumeCount, 1)

  usageSource = 'chatgpt'
  omitDetails = true
  stdout.output = ''
  instance.rerender(<Usage key="missing-details" />)
  await waitFor(() => detailsFetchCount === 5, 'missing detail response was not requested')
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()
  assert.match(stripAnsi(stdout.output), /Reset details unavailable/)
  assert.doesNotMatch(stripAnsi(stdout.output), /No used reset records returned/)
  assert.equal(consumeCount, 1)

  omitDetails = false
  fetchCount = 0
  stdout.output = ''
  instance.rerender(
    <KeybindingProvider
      bindings={parseBindings(DEFAULT_BINDINGS)}
      pendingChordRef={{ current: null }}
      pendingChord={null}
      setPendingChord={() => {}}
      activeContexts={new Set()}
      registerActiveContext={() => {}}
      unregisterActiveContext={() => {}}
      handlerRegistryRef={{ current: new Map() }}
    >
      <InputDriver />
      <Usage key="scrollable" contentHeight={12} />
    </KeybindingProvider>,
  )
  await waitFor(() => detailsFetchCount === 6, 'scrollable details were not requested')
  await new Promise(resolve => setTimeout(resolve, 0))
  flushUpdates()
  assert.doesNotMatch(stripAnsi(stdout.output), /Used reset history/)
  stdout.output = ''
  stdin.push('\x1b[6~')
  await new Promise(resolve => setTimeout(resolve, 80))
  flushUpdates()
  assert.match(stripAnsi(stdout.output), /Used reset history/)
  stdin.push('\x1b[1;5F')
  await new Promise(resolve => setTimeout(resolve, 80))
  flushUpdates()
  assert.ok(stripAnsi(stdout.output).includes(`Used: ${formatTime(previousReset.redeemed_at)}`))
  stdout.output = ''
  stdin.push('\x1b[1;5H')
  await new Promise(resolve => setTimeout(resolve, 80))
  flushUpdates()
  assert.match(stripAnsi(stdout.output), /Reset: 2/)
  stdin.push('\x1b[5~')
  stdin.push('\x1b[<65;4;4M')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(backgroundInputCount, 0)
  assert.equal(consumeCount, 1)
} finally {
  instance.unmount()
  instance.cleanup()
  for (const mocked of mocks) mocked.mockRestore()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
}

console.log('Usage.resetKeybinding.test.tsx passed')
