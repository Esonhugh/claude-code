import { afterAll, afterEach, expect, mock, spyOn, test } from 'bun:test'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}

const capabilities = await import('./model/modelCapabilities.js')
const capability = spyOn(capabilities, 'getModelCapability').mockReturnValue(
  undefined,
)
const userType = await import('./userType.js')
const ant = spyOn(userType, 'isAnt').mockReturnValue(false)
const { getContextWindowForModel, getModelMaxOutputTokens, modelSupports1M } =
  await import('./context.js')

afterAll(() => mock.restore())

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  capability.mockReturnValue(undefined)
  ant.mockReturnValue(false)
})

test.each(['claude-opus-5', 'claude-sonnet-5'])(
  '%s has native 1M input context and a conservative 32K output default',
  (model) => {
    expect(modelSupports1M(model)).toBe(true)
    expect(getContextWindowForModel(model)).toBe(1_000_000)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    })
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    expect(modelSupports1M(model)).toBe(false)
    expect(getContextWindowForModel(model)).toBe(200_000)
    expect(getContextWindowForModel(`${model}[1m]`)).toBe(200_000)
  },
)

test.each(['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
  '%s budgets against the 922K input limit, not its 1,050K total window',
  (model) => {
    expect(getContextWindowForModel(model)).toBe(922_000)
    expect(getContextWindowForModel(`${model}[1m]`)).toBe(922_000)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: 32_000,
      upperLimit: 128_000,
    })
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
    expect(getContextWindowForModel(model)).toBe(200_000)
  },
)

test('context and discovered capability overrides retain precedence', () => {
  capability.mockReturnValue({
    id: 'claude-opus-5',
    max_input_tokens: 300_000,
    max_tokens: 16_000,
  })
  expect(getContextWindowForModel('claude-opus-5')).toBe(300_000)
  expect(getModelMaxOutputTokens('claude-opus-5')).toEqual({
    default: 16_000,
    upperLimit: 16_000,
  })
  ant.mockReturnValue(true)
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '123456'
  expect(getContextWindowForModel('claude-opus-5[1m]')).toBe(123456)
})

test('unknown and legacy models keep their existing limits', () => {
  expect(getContextWindowForModel('custom-model')).toBe(200_000)
  expect(getModelMaxOutputTokens('custom-model')).toEqual({
    default: 32_000,
    upperLimit: 64_000,
  })
  expect(getModelMaxOutputTokens('claude-opus-4-6')).toEqual({
    default: 64_000,
    upperLimit: 128_000,
  })
})
