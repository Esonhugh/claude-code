import { expect, test } from 'bun:test'
import { effortLevelToSymbol, effortNotification, getEffortNotificationText } from './EffortIndicator.js'

test('uses the official xhigh and max effort symbols', () => {
  expect(effortLevelToSymbol('xhigh')).toBe('◉')
  expect(effortLevelToSymbol('max')).toBe('◈')
})

test('the footer uses the same official xhigh symbol as the picker', () => {
  expect(getEffortNotificationText('xhigh', 'claude-opus-5-5')).toBe(
    '◉ xhigh · /effort',
  )
})

test('a new effort replaces the effort notice that is still showing', () => {
  const shown = effortNotification('◐ medium · /effort')
  const incoming = effortNotification('● high · /effort')
  expect(incoming.fold?.(shown, incoming)).toMatchObject({ key: 'effort-level', text: '● high · /effort' })
})
