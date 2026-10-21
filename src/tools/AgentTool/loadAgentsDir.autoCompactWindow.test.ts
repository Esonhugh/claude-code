import { expect, test } from 'bun:test'
import { parseAgentFromJson } from './loadAgentsDir.js'

test('an agent definition keeps an autoCompactWindow from 100000 to 1000000', () => {
  const spec = { description: 'Review', prompt: 'Review it' }
  expect(parseAgentFromJson('reviewer', { ...spec, autoCompactWindow: 120_000 }, 'userSettings')?.autoCompactWindow).toBe(120_000)
  expect(parseAgentFromJson('reviewer', { ...spec, autoCompactWindow: 99_999 }, 'userSettings')).toBeNull()
  expect(parseAgentFromJson('reviewer', { ...spec, autoCompactWindow: 1_000_001 }, 'userSettings')).toBeNull()
  expect(parseAgentFromJson('reviewer', spec, 'userSettings')?.autoCompactWindow).toBeUndefined()
})
