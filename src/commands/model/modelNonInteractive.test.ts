import { afterEach, expect, test } from 'bun:test'
import { getMainLoopModelOverride, setMainLoopModelOverride } from '../../bootstrap/state.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import { call } from './modelNonInteractive.js'

afterEach(() => setMainLoopModelOverride(undefined))

test('/model in -p switches for this session only and never touches saved settings like 2.1.311', async () => {
  const updates: unknown[] = []
  const context = { messages: [], setAppState: (f: (s: object) => object) => updates.push(f({})) }
  const result = (await call('haiku', context as never)) as { value: string }
  expect(result.value).toMatch(/^Set model to `.+` for this session only$/)
  expect(updates).toEqual([])
  expect(getMainLoopModelOverride()).toContain('haiku')
})

test('fable[1m] is a model alias like 2.1.311', () => {
  expect(MODEL_ALIASES).toEqual(['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan'])
})
