import { expect, test } from 'bun:test'
import { getMaxLabelWidth } from './select.js'

test('calculates the label column from all options, not only the visible window', () => {
  const options = [
    { value: 'short', label: 'Short', description: 'short description' },
    { value: 'long', label: 'Much longer model label', description: 'long description' },
  ]

  const allWidth = getMaxLabelWidth(options, false, 1, 'short')
  const visibleWidth = getMaxLabelWidth(options.slice(0, 1), false, 1, 'short')

  expect(allWidth).toBeGreaterThan(visibleWidth)
})
