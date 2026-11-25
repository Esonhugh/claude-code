import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getIsNonInteractiveSession, setIsInteractive } from '../../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { resetCommandQueue } from '../../utils/messageQueueManager.js'
import { drainSdkEvents, reportTaskOnlyThroughWorkflow } from '../../utils/sdkEventQueue.js'
import { killAsyncAgent, registerAsyncAgent } from './LocalAgentTask.js'

let state: AppState
const wasInteractive = !getIsNonInteractiveSession()
const setAppState = (updater: (prev: AppState) => AppState) => {
  state = updater(state)
}
const selectedAgent = { agentType: 'general-purpose' } as AgentDefinition

beforeEach(() => {
  setIsInteractive(false)
  state = getDefaultAppState()
  resetCommandQueue()
  drainSdkEvents()
})
afterEach(() => {
  resetCommandQueue()
  drainSdkEvents()
  setIsInteractive(wasInteractive)
})

const register = (agentId: string) =>
  registerAsyncAgent({ agentId, description: agentId, prompt: 'p', selectedAgent, setAppState, spawnDepth: 1 })

test('an agent a workflow runs sends SDK hosts no task events of its own, like 2.1.329', () => {
  reportTaskOnlyThroughWorkflow('a-workflow-agent')
  register('a-workflow-agent')
  register('a-plain-agent')
  killAsyncAgent('a-workflow-agent', setAppState)
  killAsyncAgent('a-plain-agent', setAppState)

  const events = drainSdkEvents() as Array<{ subtype?: string; task_id?: string }>
  expect(events.filter(e => e.task_id === 'a-workflow-agent')).toEqual([])
  expect(events.filter(e => e.task_id === 'a-plain-agent').map(e => e.subtype)).toEqual(['task_started', 'task_updated'])
})
