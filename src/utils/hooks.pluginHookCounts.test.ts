import { expect, test } from 'bun:test'
;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = { VERSION: 'test' }
const { getPluginHookCounts } = await import('./hooks.js')

test('hook telemetry keeps official marketplace plugin ids whatever the marketplace name case', () => {
  const hooks = [
    { pluginId: 'demo@Esonhugh-Marketplace' },
    { pluginId: 'fmt@claude-plugins-official' },
    { pluginId: 'x@someone-else' },
  ] as Parameters<typeof getPluginHookCounts>[0]
  expect(getPluginHookCounts(hooks)).toEqual({
    'demo@Esonhugh-Marketplace': 1,
    'fmt@claude-plugins-official': 1,
    'third-party': 1,
  })
})
