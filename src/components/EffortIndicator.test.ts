import { expect, test } from 'bun:test'
import { effortLevelToSymbol, getEffortNotificationText } from './EffortIndicator.js'

test('uses the official xhigh and max effort symbols', () => {
  expect(effortLevelToSymbol('xhigh')).toBe('◉')
  expect(effortLevelToSymbol('max')).toBe('◈')
})

test('the footer uses the same official xhigh symbol as the picker', () => {
  expect(getEffortNotificationText('xhigh', 'claude-opus-5-5')).toBe(
    '◉ xhigh · /effort',
  )
})
