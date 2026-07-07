#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { setIsInteractive } from '../../bootstrap/state.js'
import { dequeue } from '../../utils/messageQueueManager.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { readWorkflowJournalCacheEntries } from './workflowJournal.js'
import { classifyWorkflowAgentError, runWorkflowScript } from './workflowScriptRuntime.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'

await import('../../tasks/LocalWorkflowTask/LocalWorkflowTask.js')
await import('./WorkflowTool.js')

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
const alpha = await agent("Reply exactly alpha-ok", { label: "alpha" })
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

let agentToolCallCount = 0
const fakeAgentTool = {
  name: 'Agent',
  async call(_input: unknown, agentContext: ToolUseContext) {
    agentToolCallCount++
    assert.equal(agentContext.options.disableNestedAgentTools, true)
    if (typeof _input === 'object' && _input && 'prompt' in _input && _input.prompt === 'fail-agent') {
      throw new Error('agent failed intentionally')
    }
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
assert.match(result, /Transcript dir: /)
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
const completionNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(completionNotification)
assert.match(String(completionNotification.value), /<summary>Dynamic workflow "Small real workflow covering phase log args budget agent parallel pipeline workflow\." completed<\/summary>/)
assert.match(String(completionNotification.value), /"alpha": "alpha-ok"/)

const workflowTask = Object.values(state.tasks).find(
  task => task.type === 'local_workflow',
)
assert.ok(workflowTask)
const transcriptDirMatch = result.match(/Transcript dir: (.+)/)
assert.ok(transcriptDirMatch?.[1])
const journalRaw = await readFile(join(transcriptDirMatch[1], 'journal.jsonl'), 'utf8')
assert.match(journalRaw, /"type":"started"/)
assert.match(journalRaw, /"type":"result"/)
assert.match(journalRaw, /"agentId":"alpha"/)

const resumedResult = await runWorkflowScript({
  script,
  plan,
  args: { case: 'unit' },
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_resume_test' } } as never,
  workflowRunId: 'wf_resume_test',
  scriptPath: '/tmp/runtime-small-workflow.js',
  resumeFromRunId: 'wf_test',
  resumeJournalEntries: await readWorkflowJournalCacheEntries(transcriptDirMatch[1]),
})
const resumedTranscriptDirMatch = resumedResult.match(/Transcript dir: (.+)/)
assert.ok(resumedTranscriptDirMatch?.[1])
const resumedJournalRaw = await readFile(join(resumedTranscriptDirMatch[1], 'journal.jsonl'), 'utf8')
assert.match(resumedJournalRaw, /"type":"started"/)
assert.match(resumedJournalRaw, /"type":"result"/)
assert.match(resumedJournalRaw, /"agentId":"alpha"/)
assert.match(resumedJournalRaw, /"result":"alpha-ok"/)
assert.equal(agentToolCallCount, 1)

const failedScript = `export const meta = {
  name: "runtime-failed-agent-workflow",
  description: "Workflow recording failed agent null result.",
  phases: [{ title: "Fail", detail: "Failing agent" }],
}
phase("Fail")
return await agent("fail-agent", { label: "failed-agent" })
`
const failedPlan: WorkflowDryRunPlan = {
  ...plan,
  name: 'runtime-failed-agent-workflow',
  description: 'Workflow recording failed agent null result.',
  phases: [
    {
      id: 'Fail',
      description: 'Failing agent',
      prompt: 'Failing agent',
      dependsOn: [],
      fanout: 1,
      concurrency: 1,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  runScriptSnapshot: failedScript,
}
const failedResult = await runWorkflowScript({
  script: failedScript,
  plan: failedPlan,
  args: { case: 'unit' },
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_failed_agent_test' } } as never,
  workflowRunId: 'wf_failed_agent_test',
  scriptPath: '/tmp/runtime-failed-agent-workflow.js',
})
const failedTranscriptDirMatch = failedResult.match(/Transcript dir: (.+)/)
assert.ok(failedTranscriptDirMatch?.[1])
const failedJournalRaw = await readFile(join(failedTranscriptDirMatch[1], 'journal.jsonl'), 'utf8')
assert.match(failedJournalRaw, /"agentId":"failed-agent"/)
assert.match(failedJournalRaw, /"result":null/)

console.log('workflowScriptRuntime.test.ts passed')
