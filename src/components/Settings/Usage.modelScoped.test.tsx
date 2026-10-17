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
process.env.ANTHROPIC_API_KEY = 'test-key'

const keybindingModule = await import('../../keybindings/useKeybinding.js')
const usageModule = await import('../../services/api/usage.js')
const extraUsageModule = await import('../../commands/extra-usage/index.js')
const overageModule = await import('../LogoV2/OverageCreditUpsell.js')
let fetchCount = 0
const mocks = [
  spyOn(keybindingModule, 'useKeybinding').mockImplementation(() => {}),
  spyOn(keybindingModule, 'useKeybindings').mockImplementation(() => {}),
  spyOn(extraUsageModule.extraUsage, 'isEnabled').mockReturnValue(false),
  spyOn(overageModule, 'isEligibleForOverageCreditGrant').mockReturnValue(false),
  spyOn(overageModule, 'OverageCreditUpsell').mockImplementation(() => null),
  spyOn(usageModule, 'fetchUtilization').mockImplementation(async () => {
    fetchCount += 1
    return {
      five_hour: { utilization: 12, resets_at: null },
      seven_day: { utilization: 40, resets_at: null },
      seven_day_sonnet: null,
      limits: [
        { kind: 'session', group: 'session', percent: 12, resets_at: null },
        { kind: 'weekly_all', group: 'weekly', percent: 40, resets_at: null },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 37.5,
          resets_at: null,
          scope: { model: { display_name: 'Fable' } },
          severity: 'normal',
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 9,
          resets_at: null,
          scope: { surface: { display_name: 'Cowork' } },
          severity: 'normal',
        },
      ],
    }
  }),
]

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

const stdout = new TestStdout()
const outputStream = stdout as unknown as NodeJS.WriteStream
const instance = await render(<Usage />, {
  stdout: outputStream,
  stdin: new TestStdin() as unknown as NodeJS.ReadStream,
  patchConsole: false,
  exitOnCtrlC: false,
})

try {
  await waitFor(() => fetchCount === 1, 'usage request did not start')
  await new Promise(resolve => setTimeout(resolve, 80))
  instances.get(outputStream)?.pause()
  instances.get(outputStream)?.resume()
  // Ink appends every repaint; assert on the last full frame.
  const frames = stripAnsi(stdout.output).split('Usage details')
  const output = `Usage details${frames[frames.length - 1]}`
  const lines = output.split('\n').map(line => line.trimEnd())
  const titles = lines.filter(line => /^Current (session|week)/.test(line))
  try {
    assert.deepEqual(titles, [
      'Current session',
      'Current week (all models)',
      'Current week (Fable)',
    ])
    assert.match(output, /Current week \(Fable\)\n[^\n]*█[^\n]* 37% used/)
    assert.doesNotMatch(output, /Cowork/)
  } catch (error) {
    console.error(`rendered usage panel:\n${output}`)
    throw error
  }
} finally {
  instance.unmount()
  for (const mock of mocks) mock.mockRestore()
}

console.log('Usage.modelScoped.test.tsx passed')
