#!/usr/bin/env node
import assert from 'node:assert/strict'

import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { setIsInteractive } from '../../bootstrap/state.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { classifyWorkflowAgentError, runWorkflowScript } from './workflowScriptRuntime.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'

assert.equal(
  classifyWorkflowAgentError(new Error('Concurrency limit exceeded for user fakeadmin')),
  'concurrency_limit',
)

assert.equal(
  classifyWorkflowAgentError(new Error('agent stalled after 120000ms')),
  'stalled',
)

assert.equal(
  classifyWorkflowAgentError(new Error('permission denied by permission policy')),
  'permission_denied',
)

assert.equal(
  classifyWorkflowAgentError(new Error('agent crashed unexpectedly')),
  'agent_failed',
)

setIsInteractive(false)
drainSdkEvents()

let state = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}

const script = `export const meta = {
  name: "runtime-small-workflow",
  description: "Small real workflow covering phase log args budget agent parallel pipeline workflow.",
  phases: [{ title: "Parallel", detail: "Two parallel agents" }],
}
phase("Parallel")
const alpha = await agent("Reply exactly alpha-ok", { label: "alpha", phase: "Parallel" })
return { alpha }
`

const plan: WorkflowDryRunPlan = {
  name: 'runtime-small-workflow',
  description: 'Small real workflow covering phase log args budget agent parallel pipeline workflow.',
  defaults: {
    maxConcurrency: 2,
    maxAgents: 2,
    maxRetries: 0,
    fanout: 1,
    concurrency: 1,
    review: 'none',
    permissionMode: 'bypassPermissions',
    execution: 'agent',
  },
  phases: [
    {
      id: 'Parallel',
      description: 'Two parallel agents',
      prompt: 'Parallel work',
      dependsOn: [],
      fanout: 1,
      concurrency: 1,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  totalAgents: 1,
  runScriptSnapshot: script,
}

const fakeAgentTool = {
  name: 'Agent',
  async call(_input: unknown, agentContext: ToolUseContext) {
    assert.equal(agentContext.options.disableNestedAgentTools, true)
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'alpha-ok' }],
        totalTokens: 7,
        totalToolUseCount: 1,
        totalDurationMs: 3,
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
  toolUseId: 'toolu_workflow_test',
} as unknown as ToolUseContext

const result = await runWorkflowScript({
  script,
  plan,
  args: { case: 'unit' },
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_test' } } as never,
  workflowRunId: 'wf_test',
  scriptPath: '/tmp/runtime-small-workflow.js',
})

assert.match(result, /Workflow launched in background\. Task ID: w/)
assert.match(result, /Summary: Small real workflow covering phase log args budget agent parallel pipeline workflow\./)
assert.match(result, /Script file: \/tmp\/runtime-small-workflow\.js/)
assert.match(result, /resumeFromRunId: "wf_test"/)
assert.doesNotMatch(result, /Result:\n/)

const events = drainSdkEvents()
const started = events.find(event => event.subtype === 'task_started')
assert.equal(started?.task_type, 'local_workflow')
assert.equal(started?.tool_use_id, 'toolu_workflow_test')
assert.equal(started?.workflow_name, 'runtime-small-workflow')
assert.equal(started?.description, 'Small real workflow covering phase log args budget agent parallel pipeline workflow.')
assert.equal(started?.prompt, script)

const progress = events.find(event => event.subtype === 'task_progress')
assert.equal(progress?.task_id, started?.task_id)
assert.equal(progress?.tool_use_id, 'toolu_workflow_test')
assert.equal(progress?.description, 'Parallel: alpha')
assert.equal(progress?.last_tool_name, 'alpha')

const notification = events.find(event => event.subtype === 'task_notification')
assert.equal(notification?.task_id, started?.task_id)
assert.equal(notification?.tool_use_id, 'toolu_workflow_test')
assert.equal(notification?.status, 'completed')
assert.match(notification?.summary ?? '', /Dynamic workflow "Small real workflow covering phase log args budget agent parallel pipeline workflow\." completed/)
assert.ok(notification?.output_file)

console.log('workflowScriptRuntime.test.ts passed')
