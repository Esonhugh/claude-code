import { expect, test } from 'bun:test'

import { getDefaultAppState, type AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { TaskStopTool } from './TaskStopTool.js'

function contextFor(agentId: string | undefined): ToolUseContext {
  const state = {
    ...getDefaultAppState(),
    tasks: {
      bmain: { id: 'bmain', type: 'local_bash', status: 'running' },
      balpha: { id: 'balpha', type: 'local_bash', status: 'running', agentId: 'aalpha' },
      aalpha: { id: 'aalpha', type: 'local_agent', status: 'running', agentId: 'aalpha' },
    },
  } as unknown as AppState
  return { getAppState: () => state, ...(agentId && { agentId }) } as unknown as ToolUseContext
}

test('the main conversation can stop any running task', async () => {
  for (const task_id of ['bmain', 'balpha', 'aalpha']) {
    expect(await TaskStopTool.validateInput!({ task_id }, contextFor(undefined))).toEqual({ result: true })
  }
})

test('a subagent stops only tasks it owns, like official 2.1.311', async () => {
  expect(await TaskStopTool.validateInput!({ task_id: 'balpha' }, contextFor('aalpha'))).toEqual({ result: true })
  expect(await TaskStopTool.validateInput!({ task_id: 'bmain' }, contextFor('aalpha'))).toEqual({
    result: false,
    message: 'Task bmain is owned by main session; agent aalpha cannot stop it.',
    errorCode: 4,
  })
  expect(await TaskStopTool.validateInput!({ task_id: 'aalpha' }, contextFor('abeta'))).toEqual({
    result: false,
    message: 'Task aalpha is owned by aalpha; agent abeta cannot stop it.',
    errorCode: 4,
  })
})

test('a teammate can be addressed by the agent id or name the spawn result reported', async () => {
  const state = {
    ...getDefaultAppState(),
    tasks: {
      tmate1: {
        id: 'tmate1',
        type: 'in_process_teammate',
        status: 'running',
        identity: { agentId: 'mate1@life', agentName: 'mate1', teamName: 'life' },
      },
    },
  } as unknown as AppState
  const context = { getAppState: () => state } as unknown as ToolUseContext
  for (const task_id of ['mate1@life', 'mate1']) {
    expect(await TaskStopTool.validateInput!({ task_id }, context)).toEqual({ result: true })
  }
})
