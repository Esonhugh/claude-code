import { afterAll, expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= { VERSION: 'test' } as MacroGlobals

const { setSessionSettingsCache } = await import('./utils/settings/settingsCache.js')
const { getEmptyToolPermissionContext } = await import('./Tool.js')
const { getTools } = await import('./tools.js')

const saved = process.env.CLAUDE_CODE_USE_OPENAI
afterAll(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_USE_OPENAI
  else process.env.CLAUDE_CODE_USE_OPENAI = saved
  setSessionSettingsCache({ settings: {}, errors: [] })
})

function editTools(provider: 'openai' | 'anthropic', openaiEditTools?: 'all' | 'apply_patch'): string[] {
  if (provider === 'openai') process.env.CLAUDE_CODE_USE_OPENAI = '1'
  else delete process.env.CLAUDE_CODE_USE_OPENAI
  setSessionSettingsCache({ settings: openaiEditTools ? { openaiEditTools } : {}, errors: [] })
  return getTools(getEmptyToolPermissionContext())
    .map(t => t.name)
    .filter(n => ['Edit', 'Write', 'apply_patch'].includes(n))
    .sort()
}

test('openaiEditTools "apply_patch" leaves GPT models only apply_patch', () => {
  expect(editTools('openai')).toEqual(['Edit', 'Write', 'apply_patch'])
  expect(editTools('openai', 'all')).toEqual(['Edit', 'Write', 'apply_patch'])
  expect(editTools('openai', 'apply_patch')).toEqual(['apply_patch'])
})

test('openaiEditTools does not change the Claude path', () => {
  expect(editTools('anthropic', 'apply_patch')).toEqual(['Edit', 'Write'])
})
