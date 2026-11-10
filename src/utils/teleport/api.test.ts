import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  ...(globalThis as typeof globalThis & { MACRO?: MacroGlobals }).MACRO,
  VERSION: '9.9.9',
} as MacroGlobals

test('getOAuthHeaders identifies the client like the official CLI', async () => {
  const { getOAuthHeaders } = await import('./api.js')
  expect(getOAuthHeaders('tok')).toEqual({
    'User-Agent': 'claude-code/9.9.9',
    Authorization: 'Bearer tok',
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  })
})
