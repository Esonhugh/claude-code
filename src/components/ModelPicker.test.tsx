import { expect, test } from 'bun:test'
import type { EffortLevel } from '../utils/effort.js'
import {
  cycleEffortLevel,
  formatEffortLevel,
  getHiddenModelCount,
  resolveInitialPickerValue,
} from './ModelPicker.js'

test('picker effort paths converge on the focused row configured levels', () => {
  const configuredLevels = ['low', 'medium', 'high', 'max'] as EffortLevel[]
  const fromAbove = cycleEffortLevel('medium', 'right', true, configuredLevels)
  const fromBelow = cycleEffortLevel('max', 'left', true, configuredLevels)
  expect(fromAbove).toBe('high')
  expect(fromBelow).toBe('high')
})

test('served aliases focus their existing full-id row', () => {
  const options = [
    { value: 'claude-opus-5-5', label: 'Opus 5.5', description: '' },
  ]

  expect(resolveInitialPickerValue('opus', options)).toBe('claude-opus-5-5')
})

test('model picker counts only the rows below the current viewport', () => {
  expect(getHiddenModelCount(14, 10)).toBe(4)
  expect(getHiddenModelCount(14, 14)).toBe(0)
})

test('model picker uses the official xHigh spelling without changing ultracode', () => {
  expect(formatEffortLevel('xhigh')).toBe('xHigh')
  expect(formatEffortLevel('ultracode')).toBe('Ultracode')
})
