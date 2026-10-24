import { expect, test } from 'bun:test'
import type { EffortLevel } from '../utils/effort.js'
import {
  cycleEffortLevel,
  formatEffortLevel,
  getHiddenModelCount,
  resolveInitialPickerValue,
  withCurrentModelOption,
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

test('a default model missing from the provider list is added and marked current', () => {
  const options = [
    { value: 'gateway-alpha', label: 'Gateway Alpha', description: 'OpenAI model' },
  ]
  const result = withCurrentModelOption(options, null, 'gpt-5.6-sol')
  expect(result[0]).toEqual({ value: null, label: 'Default (gpt-5.6-sol)', description: 'Current model' })
  expect(result.slice(1)).toEqual(options)
})

test('a listed default or a list with its own default row is left alone', () => {
  const withDefault = [{ value: null, label: 'Default (recommended)', description: '' }]
  expect(withCurrentModelOption(withDefault, null, 'claude-opus-5-5')).toBe(withDefault)
  const listed = [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: '' }]
  expect(withCurrentModelOption(listed, 'gpt-5.6-sol', 'gpt-5.6-sol')).toBe(listed)
})

test('a custom current model missing from the list is appended', () => {
  const options = [{ value: 'a', label: 'A', description: '' }]
  expect(withCurrentModelOption(options, 'custom-model', 'a').at(-1)).toEqual({
    value: 'custom-model', label: 'custom-model', description: 'Current model',
  })
})
