import { beforeEach, expect, test } from 'bun:test'

import { regenerateSessionId } from '../../bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppState.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js'
import { subagentStats } from '../../tools/AgentTool/subagentStats.js'
import { completeAgentTask, failAgentTask, killAsyncAgent, registerAsyncAgent } from './LocalAgentTask.js'

const selectedAgent = {
  agentType: 'general-purpose',
  whenToUse: 'general',
  source: 'built-in' as const,
  baseDir: 'built-in' as const,
  getSystemPrompt: () => 'general',
}

let state = {} as AppState
const setAppState = (fn: (prev: AppState) => AppState) => {
  state = fn(state)
}

beforeEach(() => {
  regenerateSessionId()
  state = {
    ...getDefaultAppState(),
    tasks: {},
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: { tools: [], clients: [] },
  } as unknown as AppState
})

function spawn(agentId: string): void {
  registerAsyncAgent({
    agentId,
    description: agentId,
    prompt: agentId,
    selectedAgent,
    setAppState,
    spawnDepth: 1,
    spawnedSubagent: subagentStats().recordSpawn({
      agentType: selectedAgent.agentType,
      runInBackground: true,
      runsInBackground: true,
      depth: 1,
    }),
  })
}

test('task completion, failure and kills record the subagent outcome once', () => {
  spawn('done')
  spawn('broken')
  spawn('stopped')
  spawn('swept')
  spawn('aborted')

  completeAgentTask({ agentId: 'done' } as AgentToolResult, setAppState)
  failAgentTask('broken', 'boom', setAppState)
  killAsyncAgent('stopped', setAppState, 'parent')
  killAsyncAgent('swept', setAppState)
  killAsyncAgent('aborted', setAppState, 'system', 'user')
  // An ended task records nothing more.
  killAsyncAgent('done', setAppState, 'user')
  failAgentTask('stopped', 'late', setAppState)

  const stats = subagentStats().snapshot()
  expect(stats.spawned).toBe(5)
  expect(stats.completed).toBe(1)
  expect(stats.failed).toBe(1)
  expect(stats.killed).toEqual({ parent: 1, user: 1, system: 1 })
})
