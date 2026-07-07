#!/usr/bin/env node
import assert from 'node:assert/strict'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { runWorkflowPlan } from './runWorkflow.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'

let state = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}

const plan: WorkflowDryRunPlan = {
  name: 'short-root-output',
  description: 'Accept short root output.',
  defaults: {
    maxConcurrency: 1,
    maxAgents: 1,
    maxRetries: 0,
    fanout: 1,
    concurrency: 1,
    review: 'none',
    permissionMode: 'bypassPermissions',
    execution: 'agent',
  },
  phases: [
    {
      id: 'root',
      description: 'Root phase',
      prompt: 'Return ok.',
      dependsOn: [],
      fanout: 1,
      concurrency: 1,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  totalAgents: 1,
}

const fakeAgentTool = {
  name: 'Agent',
  async call() {
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'ok' }],
        totalTokens: 1,
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    }
  },
}

const context = {
  getAppState: () => state,
  setAppState,
  options: {
    tools: [fakeAgentTool],
    mainLoopModel: 'claude-sonnet-4-6',
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_short_root',
} as unknown as ToolUseContext

const result = await runWorkflowPlan({
  plan,
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_short_root' } } as never,
  workflowRunId: 'wf_short_root',
})

assert.match(result, /Workflow launched in background\. Task ID: w/)
const task = Object.values(state.tasks).find(task => task.type === 'local_workflow')
assert.equal(task?.status, 'completed')

let partialState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setPartialState = (updater: (prev: AppState) => AppState): void => {
  partialState = updater(partialState)
}
let callCount = 0
const partialAgentTool = {
  name: 'Agent',
  async call() {
    callCount++
    if (callCount === 1) {
      await new Promise(resolve => setTimeout(resolve, 1))
      return {
        data: {
          status: 'completed',
          content: [{ type: 'text', text: 'useful branch output' }],
          totalTokens: 2,
          totalToolUseCount: 0,
          totalDurationMs: 1,
        },
      }
    }
    throw new Error('branch failed')
  },
}
const partialPlan: WorkflowDryRunPlan = {
  ...plan,
  name: 'partial-branch-failure',
  description: 'Preserve mixed branch results.',
  phases: [
    {
      id: 'fanout',
      description: 'Fanout phase',
      prompt: 'Run branch.',
      dependsOn: [],
      fanout: 2,
      concurrency: 2,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  totalAgents: 2,
}
const partialContext = {
  getAppState: () => partialState,
  setAppState: setPartialState,
  options: {
    tools: [partialAgentTool],
    mainLoopModel: 'claude-sonnet-4-6',
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_partial_branch',
} as unknown as ToolUseContext

const partialResult = await runWorkflowPlan({
  plan: partialPlan,
  context: partialContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_partial_branch' } } as never,
  workflowRunId: 'wf_partial_branch',
})

assert.match(partialResult, /Workflow launched in background\. Task ID: w/)
const partialTask = Object.values(partialState.tasks).find(
  task => task.type === 'local_workflow',
)
assert.ok(partialTask)
assert.equal(partialTask.status, 'failed')
assert.equal(partialTask.results.some(result => result.status === 'completed'), true)
assert.equal(partialTask.results.some(result => result.status === 'failed'), true)

console.log('runWorkflow.test.ts passed')
