import { expect, test } from 'bun:test'
import { buildCronCreatePrompt } from './prompt.js'

test('short CronCreate prompt keeps every rule with an example', () => {
  const durable = buildCronCreatePrompt(true)
  for (const rule of ['local timezone', '`recurring: false`', '"30 14 <today_dom> <today_month> *"', 'expire after 7 days', 'Avoid minute 0 and 30', '"57 8 * * *"', 'only when the user asks for it to persist', 'only while the REPL is idle', 'CronDelete'])
    expect(durable).toContain(rule)
  const sessionOnly = buildCronCreatePrompt(false)
  expect(sessionOnly).not.toContain('durable')
  expect(sessionOnly).toContain('die when Claude exits')
  expect(durable.length).toBeLessThan(1_800)
})
