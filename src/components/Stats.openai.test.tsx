import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { mock, spyOn, test } from 'bun:test'
import React from 'react'
import stripAnsi from 'strip-ansi'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
process.env.NODE_ENV = 'test'
let requests = 0
let fail = false
const { KeybindingProvider } =
  await import('../keybindings/KeybindingContext.js')
const { parseBindings } = await import('../keybindings/parser.js')
const bindings = parseBindings([
  {
    context: 'Tabs',
    bindings: {
      tab: 'tabs:next',
      'shift+tab': 'tabs:previous',
      right: 'tabs:next',
      left: 'tabs:previous',
    },
  },
])
const localStats = await import('../utils/stats.js')
const usage = await import('../services/api/usage.js')
const { Stats } = await import('./Stats.js')
const status = await import('./Settings/Status.js')
const { Settings } = await import('./Settings/Settings.js')
const { render } = await import('../ink.js')
class Output extends Writable {
  columns = 60
  rows = 40
  isTTY = false
  output = ''
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
    this.output += chunk.toString()
    callback()
  }
}
class Input extends Readable {
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
test.each([144, 80])('embedded Stats preserves chart rows and nested focus at %s columns', async columns => {
  spyOn(localStats, 'aggregateClaudeCodeStatsForRange').mockResolvedValue({
    totalSessions: 1,
    totalDays: 1,
    activeDays: 0,
    modelUsage: {},
    dailyActivity: [],
    dailyModelTokens: [],
    longestSession: null,
    peakActivityDay: null,
    streaks: { currentStreak: 0, longestStreak: 0 },
    totalSpeculationTimeSavedMs: 0,
  } as unknown as import('../utils/stats.js').ClaudeCodeStats)
  spyOn(usage, 'isOpenAIActivityAvailable').mockReturnValue(true)
  spyOn(usage, 'fetchOpenAIActivity').mockResolvedValue({
    lifetime_tokens: 42,
    current_streak_days: 31,
    longest_streak_days: 37,
    longest_running_turn_sec: 4440,
    daily_usage_buckets: [],
  })
  const nestedBindings = parseBindings([
    {
      context: 'Tabs',
      bindings: {
        tab: 'tabs:next',
        'shift+tab': 'tabs:previous',
        right: 'tabs:next',
        left: 'tabs:previous',
      },
    },
    {
      context: 'Settings',
      bindings: { esc: 'confirm:no' },
    },
    {
      context: 'Confirmation',
      bindings: { esc: 'confirm:no' },
    },
  ])
  let closeCount = 0
  spyOn(status, 'buildDiagnostics').mockResolvedValue([])
  spyOn(status, 'buildStatusUsage').mockResolvedValue(null)
  spyOn(usage, 'fetchUtilization').mockResolvedValue(null)
  function Harness() {
    return (
      <Settings
        defaultTab="Stats"
        context={{} as React.ComponentProps<typeof Settings>['context']}
        onClose={() => { closeCount++ }}
      />
    )
  }
  const stdout = new Output()
  stdout.columns = columns
  stdout.rows = columns === 80 ? 32 : 52
  const stdin = new Input()
  const instance = await render(
    <KeybindingProvider
      bindings={nestedBindings}
      pendingChordRef={{ current: null }}
      pendingChord={null}
      setPendingChord={() => {}}
      activeContexts={new Set()}
      registerActiveContext={() => {}}
      unregisterActiveContext={() => {}}
      handlerRegistryRef={{ current: new Map() }}
    >
      <Harness />
    </KeybindingProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 100)) }
  try {
    await settle()
    assert.doesNotMatch(stripAnsi(stdout.output), /No model usage data available/)
    stdin.push('\u001b[B')
    await settle()
    stdin.push('\u001b[C')
    await settle()
    assert.match(stripAnsi(stdout.output), /No model usage data available/)
    stdin.push('\u001b[C')
    await settle()
    assert.match(stripAnsi(stdout.output), /Lifetime tokens: 42/)
    stdout.output = ''
    stdin.push('\u001b[B')
    await settle()
    assert.match(stripAnsi(stdout.output), /↑\/↓ ±1 day/)
    assert.match(stripAnsi(stdout.output), /^\s*Longest turn: 1h 14m\s*$/m)
    assert.match(stripAnsi(stdout.output), /^\s*Streak: 31 days\s+Longest streak: 37 days\s*$/m)
    for (const day of ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']) {
      assert.match(stripAnsi(stdout.output), new RegExp(`^ *${day} [·■ ]+$`, 'm'))
    }
    assert.match(stripAnsi(stdout.output), /^ *Intensity: low → medium → high · · = zero · blank = future · inverse =\s+selected *$/m)
    assert.match(stripAnsi(stdout.output), /^ *K = thousand · M = million · B = billion *$/m)
    assert.match(stripAnsi(stdout.output), /^ *Weeks \d+–\d+ of 52 *$/m)
    assert.doesNotMatch(stripAnsi(stdout.output), /14mngest|of 52 = million/)
    stdin.push('\u001b[A')
    await settle()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    assert.match(
      stripAnsi(stdout.output),
      new RegExp(`${yesterday.toLocaleDateString('en-CA')}: 0 tokens`),
    )
    stdout.output = ''
    stdin.push('v')
    await settle()
    assert.match(stripAnsi(stdout.output), /Weekly \(Sunday/)
    assert.match(stripAnsi(stdout.output), /^ *Longest turn: 1h 14m *$/m)
    assert.match(stripAnsi(stdout.output), /^ *Day \d{4}-\d{2}-\d{2}: 0 tokens *$/m)
    assert.match(stripAnsi(stdout.output), /^ *Weeks \d+–\d+ of 52 *$/m)
    assert.doesNotMatch(stripAnsi(stdout.output), /14mngest|of 52 = million/)
    stdin.push('\t')
    await settle()
    stdin.push('\u001b[A')
    await settle()
    stdout.output = ''
    stdin.push('\u001b[Z')
    await settle()
    assert.match(stripAnsi(stdout.output), /Usage data is unavailable for the current OpenAI authentication\./)
    assert.doesNotMatch(stripAnsi(stdout.output), /Codex activity/)
    stdin.push('\t')
    await settle()
    stdin.push('\u001b')
    await settle()
    assert.equal(closeCount, 1)
  } finally {
    instance.unmount()
    mock.restore()
  }
})

test('local empty leaves OpenAI available, lazy cached and refreshable', async () => {
  spyOn(localStats, 'aggregateClaudeCodeStatsForRange').mockResolvedValue({
    totalSessions: 0,
  } as import('../utils/stats.js').ClaudeCodeStats)
  spyOn(usage, 'isOpenAIActivityAvailable').mockReturnValue(true)
  spyOn(usage, 'fetchOpenAIActivity').mockImplementation(async () => {
    requests++
    if (fail) throw new Error('fixture error')
    return { lifetime_tokens: 42, daily_usage_buckets: [] }
  })
  const stdout = new Output()
  const stdin = new Input()
  const instance = await render(
    <KeybindingProvider
      bindings={bindings}
      pendingChordRef={{ current: null }}
      pendingChord={null}
      setPendingChord={() => {}}
      activeContexts={new Set()}
      registerActiveContext={() => {}}
      unregisterActiveContext={() => {}}
      handlerRegistryRef={{ current: new Map() }}
    >
      <Stats onClose={() => {}} />
    </KeybindingProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  )
  async function settle() {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 3000
    while (!predicate() && Date.now() < deadline) await settle()
    assert.ok(predicate(), stripAnsi(stdout.output))
  }
  try {
    await settle()
    assert.equal(requests, 0)
    assert.match(stripAnsi(stdout.output), /No stats available yet/)
    assert.match(stripAnsi(stdout.output), /OpenAI/)
    stdin.push('\t')
    await settle()
    stdin.push('\t')
    await settle()
    assert.equal(requests, 1)
    assert.match(stripAnsi(stdout.output), /Lifetime tokens: 42/)
    assert.match(stripAnsi(stdout.output), /No token usage in this window/)
    stdin.push('\u001b[B')
    await waitFor(() => stripAnsi(stdout.output).includes('↑/↓ ±1 day'))
    stdout.output = ''
    stdin.push('\u001b[A')
    await settle()
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    await waitFor(() => stripAnsi(stdout.output).includes(
      `${yesterday.toLocaleDateString('en-CA')}: 0 tokens`,
    ))
    async function checkDay(key: string, offset: number) {
      stdin.push(key)
      await settle()
      const date = new Date()
      date.setDate(date.getDate() + offset)
      await waitFor(() => {
        const selectedDates = [...stripAnsi(stdout.output).matchAll(/(\d{4}-\d{2}-\d{2}): 0 tokens/g)]
        return selectedDates.at(-1)?.[1] === date.toLocaleDateString('en-CA')
      })
    }
    await checkDay('\u001b[D', -8)
    await checkDay('\u001b[C', -1)
    await checkDay('\u001b[B', 0)
    await checkDay('\u001b[C', 0)
    stdin.push('v')
    await settle()
    assert.match(stripAnsi(stdout.output), /Weekly \(Sunday/)
    stdin.push('\u001b[D')
    await settle()
    assert.equal(requests, 1)
    stdin.push('v')
    await settle()
    assert.match(stripAnsi(stdout.output), /window\s+cumulative/)
    stdin.push('\t')
    await settle()
    stdout.output = ''
    stdin.push('\u001b[Z')
    await settle()
    assert.ok(!stripAnsi(stdout.output).includes('Codex activity'))
    stdin.push('\t')
    await settle()
    assert.equal(requests, 1)
    fail = true
    stdin.push('r')
    await settle()
    assert.equal(requests, 2)
    assert.match(stripAnsi(stdout.output), /Failed to load OpenAI activity/)
    fail = false
    stdin.push('r')
    await settle()
    assert.equal(requests, 3)
  } finally {
    instance.unmount()
    mock.restore()
  }
})
