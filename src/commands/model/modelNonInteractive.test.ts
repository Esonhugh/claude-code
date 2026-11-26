import { afterEach, expect, spyOn, test } from 'bun:test'
import { getMainLoopModelOverride, setMainLoopModelOverride } from '../../bootstrap/state.js'
import { MODEL_ALIASES } from '../../utils/model/aliases.js'
import { renderDefaultModelSetting } from '../../utils/model/model.js'
import * as hooks from '../../utils/hooks.js'
import type { ModelSwitchVerdict } from '../../utils/hooks.js'
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
  [{ decision: 'block', reason: '[deny]: NO_SWITCH', messages: [] }, ': [deny]: NO_SWITCH'],
  [{ decision: 'ask', messages: [] }, ': confirmation required (run /model interactively to confirm)'],
  [{ decision: 'block', messages: ['one', 'two'] }, '\none\ntwo'],
] as Array<[ModelSwitchVerdict, string]>)('/model in -p words a PreModelSwitch refusal like 2.1.329', async (verdict, tail) => {
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

test('/model in -p shows hook messages after the result and runs PostModelSwitch like 2.1.329', async () => {
  const check = spyOn(modelSwitchHooks, 'checkModelSwitch').mockResolvedValue({
    decision: 'proceed',
    skipConfirm: false,
    messages: ['costs more', 'cache is cold'],
  })
  const post = spyOn(hooks, 'executePostModelSwitchHooks').mockResolvedValue(['now on haiku'])
  try {
    const context = { messages: [], setAppState: () => {} }
    const result = (await call('haiku', context as never)) as { value: string; metaMessages?: string[] }
    expect(result.value).toMatch(/^Set model to `.+` for this session only\ncosts more\ncache is cold$/)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]![0]).toMatchObject({ source: 'command', requestedModel: 'haiku' })
    expect(result.metaMessages).toEqual([expect.stringContaining('now on haiku')])
  } finally {
    check.mockRestore()
    post.mockRestore()
  }
})
