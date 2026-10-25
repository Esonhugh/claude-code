import { beforeEach, expect, mock, test } from 'bun:test'
import type { AggregatedHookResult } from './hooks.js'

let hookResults: AggregatedHookResult[] = []
const titles: Array<{ title: string; source: string }> = []
let reloads = 0

const actualHooks = await import('./hooks.js')
mock.module('./hooks.js', () => ({
  ...actualHooks,
  executeSessionStartHooks: async function* () {
    yield* hookResults
  },
  executeSetupHooks: async function* () {},
}))
mock.module('./plugins/loadPluginHooks.js', () => ({
  loadPluginHooks: async () => {},
}))
mock.module('./sessionStorage.js', () => ({
  saveCustomTitle: async (
    _sessionId: string,
    title: string,
    _path: string | undefined,
    source: string,
  ) => {
    titles.push({ title, source })
  },
}))
mock.module('../commands/reload-skills/reload-skills.js', () => ({
  reloadSkills: async () => {
    reloads++
    return { message: 'Reloaded 1 skills' }
  },
}))

const { processSessionStartHooks } = await import('./sessionStart.js')

beforeEach(() => {
  hookResults = []
  titles.length = 0
  reloads = 0
})

test('applies a SessionStart hook title on startup and resume only', async () => {
  hookResults = [{ sessionTitle: 'Release prep' }]
  await processSessionStartHooks('startup', { sessionId: 'session-1' })
  await processSessionStartHooks('resume', { sessionId: 'session-1' })
  await processSessionStartHooks('clear', { sessionId: 'session-1' })
  await processSessionStartHooks('compact', { sessionId: 'session-1' })
  expect(titles).toEqual([
    { title: 'Release prep', source: 'auto' },
    { title: 'Release prep', source: 'auto' },
  ])
})

test('reloads skills once when a SessionStart hook asks for it', async () => {
  hookResults = [{ reloadSkills: true }, { reloadSkills: true }]
  await processSessionStartHooks('startup')
  expect(reloads).toBe(1)
  hookResults = [{}]
  await processSessionStartHooks('startup')
  expect(reloads).toBe(1)
})
