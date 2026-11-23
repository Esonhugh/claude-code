import { afterEach, expect, spyOn, test } from 'bun:test'
import { getMainLoopModelOverride, setMainLoopModelOverride } from '../../bootstrap/state.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import { renderDefaultModelSetting } from '../../utils/model/model.js'
import * as modelSwitchHooks from '../../utils/model/modelSwitchHooks.js'
import { call } from './modelNonInteractive.js'

afterEach(() => setMainLoopModelOverride(undefined))

test('/model in -p switches for this session only and never touches saved settings like 2.1.311', async () => {
  const updates: unknown[] = []
  const context = { messages: [], setAppState: (f: (s: object) => object) => updates.push(f({})) }
  const result = (await call('haiku', context as never)) as { value: string }
  expect(result.value).toMatch(/^Set model to `.+` for this session only$/)
  // Only the session's effort follows the model (its saved level, here none).
  expect(updates).toEqual([{ effortValue: undefined }])
  expect(getMainLoopModelOverride()).toContain('haiku')
})

test('fable[1m] is a model alias like 2.1.311', () => {
  expect(MODEL_ALIASES).toEqual(['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan'])
})

test.each([
  [{ decision: 'block', reason: '[deny]: NO_SWITCH' }, ': [deny]: NO_SWITCH'],
  [{ decision: 'ask' }, ': confirmation required (run /model interactively to confirm)'],
] as const)('/model in -p words a PreModelSwitch refusal like 2.1.329', async (verdict, tail) => {
  const check = spyOn(modelSwitchHooks, 'checkModelSwitch').mockResolvedValue(verdict)
  try {
    const context = { messages: [], setAppState: () => {} }
    const result = (await call('haiku', context as never)) as { value: string }
    expect(result.value).toBe(
      `Model switch to ${renderDefaultModelSetting('haiku')} was blocked by a PreModelSwitch hook${tail}`,
    )
    expect(getMainLoopModelOverride()).toBeUndefined()
  } finally {
    check.mockRestore()
  }
})
