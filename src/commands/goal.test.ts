import assert from 'node:assert/strict'

import { getSessionId } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'
import type { PromptCommand } from '../types/command.js'
import type { ToolUseContext } from '../Tool.js'
import { addSessionHook, getSessionHooks } from '../utils/hooks/sessionHooks.js'
import goal from './goal.js'

const goalCommand = goal as PromptCommand

type GoalState = {
  goalStatus: { active: boolean; prompt?: string }
  sessionHooks: Map<string, { hooks: Record<string, unknown[]> }>
}

function createContext(initial: { active: boolean; prompt?: string }) {
  let state: GoalState = {
    goalStatus: { ...initial },
    sessionHooks: new Map(),
  }
  const context = {
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state as AppState) as unknown as GoalState
    },
  } as Pick<ToolUseContext, 'setAppState'> as ToolUseContext

  return {
    context,
    getState: () => state,
  }
}

const setContext = createContext({ active: false })
await goalCommand.getPromptForCommand('  finish the feature  ', setContext.context)
assert.deepEqual(setContext.getState().goalStatus, { active: true, prompt: 'finish the feature' })

const emptyContext = createContext({ active: false })
await goalCommand.getPromptForCommand('', emptyContext.context)
assert.deepEqual(emptyContext.getState().goalStatus, { active: true, prompt: '(no goal provided)' })

const clearContext = createContext({ active: true })
// Simulate the Stop hook that /goal <task> would have registered, so we can
// assert /goal clear actually removes it.
addSessionHook(
  clearContext.context.setAppState,
  getSessionId(),
  'Stop',
  '',
  {
    type: 'agent',
    prompt: (goalCommand.hooks!.Stop![0]!.hooks[0] as { prompt: string }).prompt,
    statusMessage: 'verifying goal completion',
  },
)
assert.ok(
  getSessionHooks(clearContext.getState() as never, getSessionId()).get('Stop'),
  'precondition: Stop hook should be registered before /goal clear',
)

await goalCommand.getPromptForCommand(' clear ', clearContext.context)
assert.deepEqual(clearContext.getState().goalStatus, { active: false })
assert.equal(
  getSessionHooks(clearContext.getState() as never, getSessionId()).get('Stop'),
  undefined,
  '/goal clear must unregister the Stop hook',
)

assert.equal(goalCommand.shouldRegisterHooksForCommand?.(' clear '), false)
assert.equal(goalCommand.shouldRegisterHooksForCommand?.('finish the feature'), true)
assert.equal(goalCommand.shouldQueryForCommand?.(' clear '), false)
assert.equal(goalCommand.shouldQueryForCommand?.('finish the feature'), true)

const clearPrompt = await goalCommand.getPromptForCommand(' clear ', clearContext.context)
assert.deepEqual(clearPrompt, [{ type: 'text', text: 'Goal is clear' }])

console.log('goal.test.ts passed')
