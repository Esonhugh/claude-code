#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { pauseWorkflowTask, type LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { runWorkflowPlan } from './runWorkflow.js'
import { loadWorkflowRunSession } from './workflowRunSessions.js'
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

let pauseCompletionState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setPauseCompletionState = (updater: (prev: AppState) => AppState): void => {
  pauseCompletionState = updater(pauseCompletionState)
}
let releasePausedAgent!: () => void
const pauseCompletionAgentTool = {
  name: 'Agent',
  async call() {
    const task = Object.values(pauseCompletionState.tasks).find(
      (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
    )
    assert.ok(task)
    pauseWorkflowTask(task.id, setPauseCompletionState)
    await new Promise<void>(resolve => {
      releasePausedAgent = resolve
    })
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'paused then completed' }],
        totalTokens: 3,
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    }
  },
}
const pauseCompletionCwd = await mkdtemp(join(tmpdir(), 'workflow-pause-completion-'))
const pauseCompletionContext = {
  getAppState: () => pauseCompletionState,
  setAppState: setPauseCompletionState,
  getCwd: () => pauseCompletionCwd,
  options: {
    tools: [pauseCompletionAgentTool],
    mainLoopModel: 'claude-sonnet-4-6',
    workflowRunInForeground: false,
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_pause_completion',
} as unknown as ToolUseContext
const pauseCompletionRunResult = await runWorkflowPlan({
  plan: {
    ...plan,
    name: 'deep-research',
    description: 'Named plan resume prompt.',
    requiresInput: true,
  },
  context: pauseCompletionContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_pause_completion' } } as never,
  runArgs: 'Research workflow resume prompt behavior in one concise pass.',
  workflowRunId: 'wf_pause_completion',
})
assert.match(pauseCompletionRunResult, /Workflow launched in background\. Task ID: w/)
await new Promise(resolve => setTimeout(resolve, 0))
let pauseCompletionTask = Object.values(pauseCompletionState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.ok(pauseCompletionTask)
assert.equal(pauseCompletionTask.status, 'pending')
assert.match(
  pauseCompletionTask.summary ?? '',
  /Workflow\(\{name: "deep-research", args: "Research workflow resume prompt behavior in one concise pass\.", resumeFromRunId: "wf_pause_completion"\}\)/,
)
releasePausedAgent()
await new Promise(resolve => setTimeout(resolve, 20))
pauseCompletionTask = pauseCompletionState.tasks[pauseCompletionTask.id] as LocalWorkflowTaskState
assert.equal(pauseCompletionTask.status, 'pending')
const pauseCompletionSession = await loadWorkflowRunSession({
  cwd: pauseCompletionCwd,
  workflowRunId: 'wf_pause_completion',
})
assert.equal(pauseCompletionSession?.status, 'paused')
assert.equal(pauseCompletionSession?.runArgs, 'Research workflow resume prompt behavior in one concise pass.')
assert.equal(
  pauseCompletionSession?.resumePrompt,
  'Workflow({name: "deep-research", args: "Research workflow resume prompt behavior in one concise pass.", resumeFromRunId: "wf_pause_completion"})',
)

let pauseAbortState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setPauseAbortState = (updater: (prev: AppState) => AppState): void => {
  pauseAbortState = updater(pauseAbortState)
}
const pauseAbortAgentTool = {
  name: 'Agent',
  async call(_input: unknown, agentContext: ToolUseContext) {
    const task = Object.values(pauseAbortState.tasks).find(
      (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
    )
    assert.ok(task)
    pauseWorkflowTask(task.id, setPauseAbortState)
    assert.equal(agentContext.abortController.signal.reason, 'workflow-paused')
    throw new Error('aborted by pause')
  },
}
const pauseAbortCwd = await mkdtemp(join(tmpdir(), 'workflow-pause-abort-'))
const pauseAbortContext = {
  getAppState: () => pauseAbortState,
  setAppState: setPauseAbortState,
  getCwd: () => pauseAbortCwd,
  options: {
    tools: [pauseAbortAgentTool],
    mainLoopModel: 'claude-sonnet-4-6',
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_pause_abort',
} as unknown as ToolUseContext
await runWorkflowPlan({
  plan: {
    ...plan,
    name: 'deep-research',
    description: 'Named plan paused session prompt.',
    requiresInput: true,
  },
  context: pauseAbortContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_pause_abort' } } as never,
  runArgs: 'Research workflow resume prompt behavior in one concise pass.',
  workflowRunId: 'wf_pause_abort',
})
const pauseAbortSession = await loadWorkflowRunSession({
  cwd: pauseAbortCwd,
  workflowRunId: 'wf_pause_abort',
})
assert.equal(pauseAbortSession?.status, 'paused')
assert.equal(
  pauseAbortSession?.resumePrompt,
  'Workflow({name: "deep-research", args: "Research workflow resume prompt behavior in one concise pass.", resumeFromRunId: "wf_pause_abort"})',
)

console.log('runWorkflow.test.ts passed')
