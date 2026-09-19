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
const consumedIds: Array<string | undefined> = []
let failDetails = false
let omitDetails = false
let longList = false
let finishDetails: (() => void) | undefined
let usageSource: 'chatgpt' | 'claude' = 'chatgpt'
const resetCredit = {
  id: 'fixture-credit',
  reset_type: 'codex_rate_limits',
  status: 'available',
  granted_at: '2026-06-17T00:00:00Z',
  expires_at: '2026-07-17T00:00:00Z',
  title: 'Full reset (Weekly + 5 hr)',
}
const secondCredit = {
  ...resetCredit,
  id: 'second-credit',
  title: 'Five-hour reset',
  granted_at: 'invalid',
  expires_at: null,
}
const previousReset = {
  ...resetCredit,
  id: 'previous-credit',
  title: 'Previously used reset',
  status: 'redeemed',
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
      rate_limit_reset_credits: { available_count: 1 },
    }
  }),
  spyOn(usageModule, 'fetchRateLimitResetCredits').mockImplementation(async () => {
    detailsFetchCount += 1
    if (failDetails) throw new Error('reset details offline')
    if (omitDetails) return null
    if (longList) {
      await new Promise<void>(resolve => { finishDetails = resolve })
      return {
        available_count: 8,
        credits: Array.from({ length: 8 }, (_, i) => ({
          ...resetCredit,
          id: `long-credit-${i}`,
          title: `Reset option ${i + 1}`,
          expires_at: undefined,
        })),
      }
    }
    return {
      available_count: consumedIds.length === 0 ? 2 : 0,
      total_earned_count: 3,
      credits: consumedIds.length === 0
        ? [secondCredit, previousReset, resetCredit, { ...resetCredit, id: 'unknown-credit', title: 'Unknown status reset', status: 'future_status' }]
        : [{ ...secondCredit, status: 'redeemed', redeemed_at: '2026-06-19T10:00:00Z' }, previousReset],
    }
  }),
  spyOn(usageModule, 'consumeRateLimitResetCredit').mockImplementation(async (creditId?: string) => {
    consumedIds.push(creditId)
    return { code: 'reset', windows_reset: 2 }
  }),
]

function getActiveKeybinding(action: string) {
  const call = keybindingCalls.findLast(call => call.action === action)
  return call?.isActive === false ? undefined : call
}

const { render, useInput, Box } = await import('../../ink.js')
const { TerminalSizeContext } = await import('../../ink/components/TerminalSizeContext.js')
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
  columns = 120
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
  setRawMode(value: boolean) { this.isRaw = value; return this }
  ref() { return this }
  unref() { return this }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > 1000) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let ownsEsc = false
const onOwnsEscChange = (value: boolean) => { ownsEsc = value }
const stdout = new TestStdout()
const stdin = new TestStdin()
const outputStream = stdout as unknown as NodeJS.WriteStream
const instance = await render(<Usage onOwnsEscChange={onOwnsEscChange} />, {
  stdout: outputStream,
  stdin: stdin as unknown as NodeJS.ReadStream,
  patchConsole: false,
  exitOnCtrlC: false,
})
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 80))
  instances.get(outputStream)?.pause()
  instances.get(outputStream)?.resume()
}
const press = async (action: string) => {
  const binding = getActiveKeybinding(action)
  assert.ok(binding, `${action} is not active`)
  binding.handler()
  await settle()
}

try {
  await waitFor(() => detailsFetchCount === 1, 'initial details request did not start')
  await settle()
  const initialOutput = stripAnsi(stdout.output)
  assert.match(initialOutput, /2 available/)
  assert.match(initialOutput, /█[^\n]* 25% used/)
  assert.ok(initialOutput.split('\n').some(line => line.includes('Usage details') && line.includes('Reset credits')), 'wide layout must show both headings on the same row')
  assert.ok(initialOutput.includes(`Granted: ${formatTime(resetCredit.granted_at)}`))
  assert.ok(initialOutput.includes(`Expires: ${formatTime(resetCredit.expires_at)}`))
  assert.match(initialOutput, /Does not expire/)
  assert.match(initialOutput, /Granted: Unavailable/)
  assert.doesNotMatch(initialOutput, /Used reset history|Previously used reset|History may be incomplete|Unknown status reset/)
  assert.ok(initialOutput.indexOf(resetCredit.title) < initialOutput.indexOf(secondCredit.title), 'expiring credit must sort first')
  assert.equal(consumedIds.length, 0)
  assert.equal(getActiveKeybinding('settings:close'), undefined, 'Enter must not redeem an unselected card')

  await press('select:next')
  await press('select:next')
  stdout.output = ''
  await press('settings:close')
  const confirmation = stripAnsi(stdout.output)
  assert.match(confirmation, /Use this reset\?/)
  assert.match(confirmation, /Five-hour reset/)
  assert.match(confirmation, /second-credit/)
  assert.equal(ownsEsc, true)
  assert.equal(getActiveKeybinding('select:next'), undefined, 'selection is frozen during confirmation')
  assert.equal(consumedIds.length, 0, 'opening confirmation must not consume')
  await press('confirm:no')
  assert.equal(ownsEsc, false)
  assert.equal(consumedIds.length, 0)

  await press('select:previous')
  await press('select:next')
  await press('settings:close')
  const confirmReset = getActiveKeybinding('confirm:yes')
  assert.ok(confirmReset)
  assert.equal(confirmReset.context, 'Confirmation')
  stdout.output = ''
  confirmReset.handler()
  assert.equal(confirmReset.handler(), false)
  await waitFor(() => consumedIds.length === 1 && fetchCount === 2, 'mock reset did not refresh')
  await settle()
  assert.deepEqual(consumedIds, ['second-credit'])
  assert.equal(detailsFetchCount, 2)
  assert.equal(ownsEsc, false)
  assert.match(stripAnsi(stdout.output), /Usage reset\./)
  assert.match(stripAnsi(stdout.output), /0 available/)
  assert.match(stripAnsi(stdout.output), /No available reset credits/)
  assert.doesNotMatch(stripAnsi(stdout.output), /Used reset history|Previously used reset|Used:/)
  assert.equal(getActiveKeybinding('settings:close'), undefined)

  failDetails = true
  stdout.output = ''
  keybindingCalls.length = 0
  instance.rerender(<Usage key="offline" />)
  await waitFor(() => detailsFetchCount === 3, 'detail failure was not requested')
  await settle()
  const offlineOutput = stripAnsi(stdout.output)
  assert.match(offlineOutput, /ChatGPT Codex weekly usage/)
  assert.match(offlineOutput, /1 available/)
  assert.match(offlineOutput, /Reset details unavailable/)
  assert.equal(getActiveKeybinding('settings:close'), undefined, 'summary-only state cannot silently auto-select a card')
  failDetails = false
  stdout.output = ''
  await press('settings:retry')
  await waitFor(() => detailsFetchCount === 4, 'detail retry was not requested')
  await settle()
  assert.match(stripAnsi(stdout.output), /No available reset credits/)
  assert.doesNotMatch(stripAnsi(stdout.output), /Reset details unavailable/)

  usageSource = 'claude'
  stdout.output = ''
  instance.rerender(<Usage key="claude" />)
  await waitFor(() => fetchCount === 5, 'Claude usage was not requested')
  await settle()
  assert.equal(detailsFetchCount, 4)
  assert.doesNotMatch(stripAnsi(stdout.output), /Reset credits|Use this reset|Used reset history/)

  usageSource = 'chatgpt'
  omitDetails = true
  stdout.output = ''
  instance.rerender(<Usage key="missing-details" />)
  await waitFor(() => detailsFetchCount === 5, 'missing details were not requested')
  await settle()
  assert.match(stripAnsi(stdout.output), /Reset details unavailable/)
  assert.doesNotMatch(stripAnsi(stdout.output), /No available reset credits/)
  assert.equal(getActiveKeybinding('settings:close'), undefined)

  omitDetails = false
  longList = true
  stdout.output = ''
  const scrollableUsage = (columns: number) => (
    <TerminalSizeContext.Provider value={{ columns, rows: 40 }}>
    <Box width={columns}>
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
      <Usage key="scrollable" contentHeight={16} />
    </KeybindingProvider>
    </Box>
    </TerminalSizeContext.Provider>
  )
  instance.rerender(scrollableUsage(120))
  await waitFor(() => detailsFetchCount === 6, 'scrollable details were not requested')
  await settle()
  assert.match(stripAnsi(stdout.output), /Loading reset details/)
  stdout.output = ''
  assert.ok(finishDetails)
  finishDetails()
  await settle()
  assert.match(stripAnsi(stdout.output), /Usage details/, 'async details must keep the viewport at the top')
  assert.match(stripAnsi(stdout.output), /8 available/)
  assert.match(stripAnsi(stdout.output), /Reset option 1/)
  assert.match(stripAnsi(stdout.output), /Expires: Unavailable/)
  assert.doesNotMatch(stripAnsi(stdout.output), /Reset option 8/)
  stdout.output = ''
  stdin.push('\x1b[1;5F')
  await settle()
  assert.match(stripAnsi(stdout.output), /Reset option 8/)
  stdout.output = ''
  stdin.push('\x1b[1;5H')
  await settle()
  assert.match(stripAnsi(stdout.output), /Usage details/)
  for (let i = 0; i < 8; i++) {
    stdout.output = ''
    await press('select:next')
  }
  assert.match(stripAnsi(stdout.output), /Reset option 8/, 'selected card must scroll into view')
  assert.doesNotMatch(stripAnsi(stdout.output), /Use this reset\?/)

  stdout.output = ''
  instance.rerender(scrollableUsage(72))
  await settle()
  stdin.push('\x1b[1;5H')
  await settle()
  const narrowOutput = stripAnsi(stdout.output)
  assert.match(narrowOutput, /25% used/)
  assert.ok(!narrowOutput.split('\n').some(line => line.includes('Usage details') && line.includes('Reset credits')), 'narrow layout must stack the sections')
  stdout.output = ''
  stdin.push('\x1b[6~')
  await settle()
  stdin.push('\x1b[1;5F')
  await settle()
  assert.match(stripAnsi(stdout.output), /Reset option 8/)
  stdin.push('\x1b[5~')
  stdin.push('\x1b[<65;4;4M')
  await settle()
  assert.equal(backgroundInputCount, 0)
  assert.deepEqual(consumedIds, ['second-credit'])
} finally {
  instance.unmount()
  instance.cleanup()
  for (const mocked of mocks) mocked.mockRestore()
  if (originalOpenAI === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
}

console.log('Usage.resetKeybinding.test.tsx passed')
