#!/usr/bin/env node
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { mock } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
process.env.NODE_ENV = 'test'
process.env.CLAUDE_CODE_USE_OPENAI = '1'
process.env.ANTHROPIC_API_KEY = 'test-key'

let fetchCount = 0
let consumeCount = 0
const keybindingCalls: Array<{
  action: string
  handler: () => void | false
  context?: string
  isActive?: boolean
}> = []

mock.module('../../keybindings/useKeybinding.js', () => ({
  useKeybinding: (
    action: string,
    handler: () => void | false,
    options: { context?: string; isActive?: boolean } = {},
  ) => {
    keybindingCalls.push({ action, handler, ...options })
  },
  useKeybindings: () => {},
}))

function getActiveKeybinding(action: string) {
  return keybindingCalls.findLast(
    call => call.action === action && call.isActive !== false,
  )
}

mock.module('../../commands/extra-usage/index.js', () => ({
  extraUsage: { isEnabled: () => false },
}))

mock.module('../LogoV2/OverageCreditUpsell.js', () => ({
  isEligibleForOverageCreditGrant: () => false,
  OverageCreditUpsell: () => null,
}))

mock.module('../../services/api/usage.js', () => ({
  fetchUtilization: () => {
    fetchCount += 1
    return Promise.resolve({
      source: 'chatgpt',
      chatgpt_limits: [],
      rate_limit_reset_credits: {
        available_count: fetchCount === 1 ? 1 : 0,
      },
    })
  },
  consumeRateLimitResetCredit: () => {
    consumeCount += 1
    return Promise.resolve({ code: 'reset', windows_reset: 2 })
  },
}))

const { render } = await import('../../ink.js')
const instances = (await import('../../ink/instances.js')).default
const { Usage } = await import('./Usage.js')

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
} finally {
  instance.unmount()
  instance.cleanup()
}

console.log('Usage.resetKeybinding.test.tsx passed')
