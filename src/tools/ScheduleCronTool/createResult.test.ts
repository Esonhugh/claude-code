import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const { cronToHuman } = await import('../../utils/cron.js')
const { CronCreateTool } = await import('./CronCreateTool.js')

// Like 2.1.311: a readable schedule and when it next runs.
test('every-minute cron reads as "Every minute"', () => {
  expect(cronToHuman('* * * * *')).toBe('Every minute')
})

test('the create result says when the task next runs', () => {
  const nextFireAt = new Date(2026, 9, 31, 20, 3).getTime()
  const block = CronCreateTool.mapToolResultToToolResultBlockParam(
    { id: 'a1', humanSchedule: 'Every minute', recurring: false, durable: false, nextFireAt },
    'toolu_1',
  )
  expect(block.content).toBe(
    'Scheduled one-shot task a1 (Every minute). Next run: Oct 31 8:03pm. Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.',
  )
})
