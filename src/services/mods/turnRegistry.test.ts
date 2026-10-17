import { afterEach, expect, test } from 'bun:test'
import { createModTurnRegistry } from './turnRegistry.js'
import { createModsRuntime } from './runtime.js'

const runtimes: ReturnType<typeof createModsRuntime>[] = []
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose() })

test('host registry keeps main and agent identities independent without a parent fallback', () => {
  const registry = createModTurnRegistry<{ turnId: string; agentId?: string }>()
  const main = { turnId: 'main' }, agent = { turnId: 'agent-turn', agentId: 'agent' }
  registry.admit(main); registry.admit(agent)
  expect(registry.current()).toBe(main)
  expect(registry.current('agent')).toBe(agent)
  expect(registry.current('unregistered')).toBeUndefined()
  registry.release(agent)
  expect(registry.current()).toBe(main)
  expect(registry.current('agent')).toBeUndefined()
})

test('host registry releases only its own object and clearing retires all scopes', () => {
  const registry = createModTurnRegistry<{ turnId: string; agentId?: string }>()
  const old = { turnId: 'old', agentId: 'agent' }, newer = { turnId: 'new', agentId: 'agent' }
  registry.admit(old); registry.admit(newer)
  registry.release(old); registry.release(old)
  expect(registry.current('agent')).toBe(newer)
  registry.admit({ turnId: 'main' })
  registry.clear()
  expect(registry.current()).toBeUndefined()
  expect(registry.current('agent')).toBeUndefined()
})

async function runtime() {
  const value = createModsRuntime()
  runtimes.push(value)
  await value.bind({ cwd: 'builtin:turn-registry', sessionId: 'one', surface: null, isInteractive: false })
  return value
}

test('host-owned agent finish releases before callbacks and settles completion exactly once', async () => {
  const value = await runtime()
  const observed: Array<{ turn: unknown; id: unknown }> = []
  value.registerHostHook({ plugin: 'turn-observer', tier: 'user', registration: { id: 1, event: 'turn.complete', hasCatch: false },
    invoke: async (input, next) => { observed.push({ turn: value.currentTurn(input.agentId as string), id: input.turnId }); return next(input) } })
  const turn = value.beginAgentTurn('agent')!
  expect(value.currentTurn('agent')).toBe(turn)
  const first = turn.finish({ aborted: false, failed: false })
  const again = turn.finish({ aborted: true, failed: true })
  expect(first).toBe(again)
  expect(value.currentTurn('agent')).toBeUndefined()
  await first
  expect(observed).toEqual([{ turn: undefined, id: turn.turnId }])
})

test('agent admission requires a current step or complete hook while main always registers', async () => {
  const value = await runtime()
  expect(value.beginAgentTurn('unhooked')).toBeUndefined()
  const release = value.beginPublicTurn('main-without-hooks')
  expect(value.currentTurn()?.turnId).toBe('main-without-hooks')
  expect(value.activePublicTurnId).toBe('main-without-hooks')
  release(); release()
  expect(value.currentTurn()).toBeUndefined()
  expect(value.activePublicTurnId).toBeUndefined()
})

test('same-session bind preserves a legitimate owner and session change fences its completion', async () => {
  const value = await runtime()
  const completions: unknown[] = []
  value.registerHostHook({ plugin: 'turn-observer', tier: 'user', registration: { id: 1, event: 'turn.complete', hasCatch: false },
    invoke: async (input, next) => { completions.push(input.turnId); return next(input) } })
  const turn = value.beginAgentTurn('agent')!
  await value.bind({ cwd: 'builtin:presentation-changed', sessionId: 'one', surface: 'terminal', isInteractive: true })
  expect(value.currentTurn('agent')).toBe(turn)
  await value.bind({ cwd: 'builtin:turn-registry', sessionId: 'two', surface: null, isInteractive: false })
  expect(value.currentTurn('agent')).toBeUndefined()
  await turn.finish({ aborted: false, failed: false })
  expect(completions).toEqual([])
  const current = value.beginAgentTurn('agent')!
  await current.finish({ aborted: false, failed: false })
  expect(completions).toEqual([current.turnId])
})

test('dispose fences an old owner before it can capture a new completion lease', async () => {
  const value = await runtime()
  const completions: unknown[] = []
  value.registerHostHook({ plugin: 'turn-observer', tier: 'user', registration: { id: 1, event: 'turn.complete', hasCatch: false },
    invoke: async (input, next) => { completions.push(input.turnId); return next(input) } })
  const turn = value.beginAgentTurn('agent')!
  await value.dispose()
  expect(value.currentTurn('agent')).toBeUndefined()
  expect(await turn.finish({ aborted: false, failed: false })).toBeUndefined()
  expect(completions).toEqual([])
})
