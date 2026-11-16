import { expect, test } from 'bun:test'
import { isUserStop, replStopOf, replStopReport, type ReplCallRecord } from './stopReport.js'

const replUserStopReport = (calls: ReplCallRecord[]) => replStopReport({ by: 'user', calls })

const HEADLINE =
  'The user interrupted this script, so it stopped. STOP what you are doing and wait for the user to tell you how to proceed.'

test('only "user-cancel" and "remote-cancel" are user stops', () => {
  expect(isUserStop('user-cancel')).toBe(true)
  expect(isUserStop('remote-cancel')).toBe(true)
  expect(isUserStop('background')).toBe(false)
  expect(isUserStop(undefined)).toBe(false)
})

test('a script with no tool calls says so', () => {
  expect(replUserStopReport([])).toBe(`${HEADLINE}\nThe script had not started any tool calls.`)
})

test('each call is listed with its state', () => {
  const calls: ReplCallRecord[] = [
    { toolName: 'Read', toolInput: { file_path: 'a', opts: { deep: 1 } }, phase: 'complete', value: { lines: 2 } },
    { toolName: 'Bash', toolInput: { command: 'x' }, phase: 'error', error: 'exit 1' },
    { toolName: 'Grep', toolInput: ['p'], phase: 'start' },
    { toolName: 'Glob', toolInput: 'line\u2028break', phase: 'complete', value: '' },
  ]
  expect(replUserStopReport(calls)).toBe(
    [
      HEADLINE,
      'Tool calls the script started, in order:',
      '1. Read({"file_path":"a","opts":"(not shown)"}) finished. It returned:',
      '  { lines: 2 }',
      '2. Bash({"command":"x"}) failed with this error:',
      '  exit 1',
      '3. Grep(["(not shown)"]) was waiting to run when the script stopped. The script got no result, and the call may still have run afterwards.',
      '4. Glob("line\\u2028break") finished. It returned:',
      "  ''",
      'That is every tool call the script started.',
    ].join('\n'),
  )
})

test('calls past the 30th are counted, and a long value loses its middle', () => {
  const long = 'x'.repeat(5000)
  const calls: ReplCallRecord[] = [
    { toolName: 'Read', toolInput: {}, phase: 'complete', value: long },
    ...Array.from({ length: 31 }, (): ReplCallRecord => ({ toolName: 'Read', toolInput: {}, phase: 'complete', value: 'ok' })),
    { toolName: 'Bash', toolInput: {}, phase: 'executing' },
  ]
  const report = replUserStopReport(calls)
  expect(report).toContain('  ... [the middle 3,104 of its 5,000 characters are not shown] ...')
  expect(report).toContain('3 more tool calls are not listed: 2 finished (Read \u00D72), 1 was still running (Bash \u00D71).')
  expect(report).not.toContain('31. ')
})

test('a declined call makes the stop a refusal, whatever the abort reason', () => {
  const declined: ReplCallRecord = { toolName: 'Bash', toolInput: { command: 'rm x' }, phase: 'error', error: 'denied', declined: true }
  expect(replStopOf(undefined, [declined])?.by).toBe('refusal')
  expect(replStopOf('user-cancel', [{ ...declined, declined: undefined }])?.by).toBe('user')
  expect(replStopOf(new DOMException('x', 'AbortError'), [])).toBeUndefined()
})

test('a refusal names the declined call', () => {
  const calls: ReplCallRecord[] = [
    { toolName: 'Read', toolInput: { file_path: 'a' }, phase: 'complete', value: 'text' },
    { toolName: 'Bash', toolInput: { command: 'rm x' }, phase: 'error', error: 'denied', declined: true },
  ]
  expect(replStopReport({ by: 'refusal', calls })).toBe(
    [
      "The user doesn't want to proceed with this tool use. STOP what you are doing and wait for the user to tell you how to proceed. The user declined the permission prompt for Bash({\"command\":\"rm x\"}), so the script stopped.",
      'Tool calls the script started, in order:',
      '1. Read({"file_path":"a"}) finished. It returned:',
      '  text',
      '2. Bash({"command":"rm x"}) did not run. The user declined it.',
      'That is every tool call the script started.',
    ].join('\n'),
  )
})

test('a shell result shows its output, and a record of texts its keys', () => {
  const calls: ReplCallRecord[] = [
    { toolName: 'Bash', toolInput: {}, phase: 'complete', value: { output: 'built', stdout: 'built', exitCode: 0 } },
    { toolName: 'Read', toolInput: {}, phase: 'complete', value: { a: 'one', b: { output: 'two', stdout: '', exitCode: null } } },
    { toolName: 'Read', toolInput: {}, phase: 'complete', value: { stdout: 'kept for inspect' } },
  ]
  const report = replUserStopReport(calls)
  expect(report).toContain('1. Bash({}) finished. It returned:\n  built\n')
  expect(report).toContain('2. Read({}) finished. It returned:\n  a:\n  one\n  \n  b:\n  two\n')
  expect(report).toContain("3. Read({}) finished. It returned:\n  { stdout: 'kept for inspect' }\n")
})

test('a finished image Read shows the placeholder the script saw, not its base64', () => {
  const base64 = 'Q'.repeat(40)
  const report = replUserStopReport([
    { toolName: 'Read', toolInput: { file_path: 'a.png' }, phase: 'complete', value: { type: 'image', file: { base64, type: 'image/png' } } },
  ])
  expect(report).toContain('[40 base64 chars — image bytes moved to the REPL result, subject to its per-result image cap]')
  expect(report).not.toContain(base64)
})
