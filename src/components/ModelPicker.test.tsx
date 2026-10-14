import { expect, test } from 'bun:test'
import type { EffortLevel } from '../utils/effort.js'
import { cycleEffortLevel, resolveInitialPickerValue } from './ModelPicker.js'

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
