import assert from 'node:assert/strict'

import type { PromptCommand } from '../types/command.js'
import goal from './goal.js'

const goalCommand = goal as PromptCommand

type GoalState = {
  goalStatus: { active: boolean; prompt?: string }
}

function createContext(initial: GoalState) {
  let state = initial
  return {
    context: {
      setAppState: (updater: (prev: GoalState) => GoalState) => {
        state = updater(state)
      },
    } as never,
    getState: () => state,
  }
}

const setContext = createContext({ goalStatus: { active: false } })
await goalCommand.getPromptForCommand('  finish the feature  ', setContext.context)
assert.deepEqual(setContext.getState().goalStatus, { active: true, prompt: 'finish the feature' })

const emptyContext = createContext({ goalStatus: { active: false } })
await goalCommand.getPromptForCommand('', emptyContext.context)
assert.deepEqual(emptyContext.getState().goalStatus, { active: true, prompt: '(no goal provided)' })

const clearContext = createContext({
  goalStatus: { active: true },
})
await goalCommand.getPromptForCommand(' clear ', clearContext.context)
assert.deepEqual(clearContext.getState().goalStatus, { active: false })
assert.equal(goalCommand.shouldRegisterHooksForCommand?.(' clear '), false)
assert.equal(goalCommand.shouldRegisterHooksForCommand?.('finish the feature'), true)
assert.equal(goalCommand.shouldQueryForCommand?.(' clear '), false)
assert.equal(goalCommand.shouldQueryForCommand?.('finish the feature'), true)

const clearPrompt = await goalCommand.getPromptForCommand(' clear ', clearContext.context)
assert.deepEqual(clearPrompt, [{ type: 'text', text: 'Goal is clear' }])

console.log('goal.test.ts passed')
