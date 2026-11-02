import { expect, test } from 'bun:test'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO ??= {
  VERSION: 'test',
} as MacroGlobals

const { SkillTool } = await import('./SkillTool.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')

test('an unknown skill names the closest command like 2.1.311', async () => {
  const appState = getDefaultAppState()
  const context = { getAppState: () => appState, options: { commands: [] } }
  const result = await SkillTool.validateInput!({ skill: 'nope' } as never, context as never)
  expect(result).toMatchObject({ result: false, message: 'Unknown skill: nope. Did you mean copy?', errorCode: 2 })
})
