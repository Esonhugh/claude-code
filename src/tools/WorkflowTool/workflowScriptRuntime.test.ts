#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { setIsInteractive } from '../../bootstrap/state.js'
import { dequeue, dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { drainSdkEvents } from '../../utils/sdkEventQueue.js'
import { readWorkflowJournalCacheEntries } from './workflowJournal.js'
import { loadWorkflowRunSession } from './workflowRunSessions.js'
import { classifyWorkflowAgentError, runWorkflowScript } from './workflowScriptRuntime.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'
import { retryWorkflowAgent, skipWorkflowAgent, type LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

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
dequeueAllMatching(command => command.mode === 'task-notification')

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
let observedScriptLiveTokens: number | undefined
let observedScriptLiveToolUses: number | undefined
const fakeAgentTool = {
  name: 'Agent',
  async call(
    _input: unknown,
    agentContext: ToolUseContext,
    _canUseTool: unknown,
    _assistantMessage: unknown,
    onProgress?: (progress: unknown) => void,
  ) {
    agentToolCallCount++
    assert.equal(agentContext.options.disableNestedAgentTools, true)
    if (typeof _input === 'object' && _input && 'prompt' in _input && _input.prompt === 'fail-agent') {
      throw new Error('agent failed intentionally')
    }
    onProgress?.({
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000010',
          timestamp: '2026-07-14T00:00:00.000Z',
          message: {
            id: 'msg_script_progress',
            role: 'assistant',
            model: 'claude-test',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_script_live',
                name: 'Read',
                input: { file_path: 'package.json' },
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
              input_tokens: 50,
              output_tokens: 5,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
        },
      },
    })
    const liveTask = Object.values(state.tasks).find(
      task => task.type === 'local_workflow',
    )
    const liveAgent = Object.values(liveTask?.liveAgents ?? {})[0]
    observedScriptLiveTokens = liveAgent?.tokenCount
    observedScriptLiveToolUses = liveAgent?.toolUseCount
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'alpha-ok' }],
        totalDurationMs: 3,
      },
    }
  },
}

const scriptCwd = await mkdtemp(join(tmpdir(), 'workflow-script-results-'))
const context = {
  getAppState: () => state,
  setAppState,
  getCwd: () => scriptCwd,
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
assert.equal(observedScriptLiveTokens, 55)
assert.equal(observedScriptLiveToolUses, 1)
assert.equal(workflowTask.tokenCount, 55)
assert.equal(workflowTask.toolUseCount, 1)
const transcriptDirMatch = result.match(/Transcript dir: (.+)/)
assert.ok(transcriptDirMatch?.[1])
const journalRaw = await readFile(join(transcriptDirMatch[1], 'journal.jsonl'), 'utf8')
assert.match(journalRaw, /"type":"started"/)
assert.match(journalRaw, /"type":"result"/)
assert.match(journalRaw, /"agentId":"alpha"/)
const scriptSession = await loadWorkflowRunSession({ cwd: scriptCwd, workflowRunId: 'wf_test' })
assert.equal(scriptSession?.status, 'completed')
assert.equal(scriptSession?.results.length, 1)
assert.equal(scriptSession?.results[0]?.status, 'completed')
assert.equal(scriptSession?.results[0]?.tokenCount, 55)
assert.equal(scriptSession?.results[0]?.toolUseCount, 1)

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
dequeueAllMatching(command => command.mode === 'task-notification')

let duplicateState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setDuplicateState = (updater: (prev: AppState) => AppState): void => {
  duplicateState = updater(duplicateState)
}
let duplicateAgentCallCount = 0
const duplicateAgentTool = {
  name: 'Agent',
  async call() {
    duplicateAgentCallCount++
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: `duplicate-${duplicateAgentCallCount}` }],
        totalTokens: 1,
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    }
  },
}
const duplicateContext = {
  getAppState: () => duplicateState,
  setAppState: setDuplicateState,
  options: {
    tools: [duplicateAgentTool],
    mainLoopModel: 'claude-sonnet-4-6',
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_duplicate_identity',
} as unknown as ToolUseContext
const duplicateScript = `export const meta = {
  name: "runtime-duplicate-agent-workflow",
  description: "Workflow preserving duplicate identical agent calls.",
  phases: [{ title: "Duplicate", detail: "Duplicate identical calls" }],
}
phase("Duplicate")
const first = await agent("same prompt")
const second = await agent("same prompt")
return { first, second }
`
const duplicatePlan: WorkflowDryRunPlan = {
  ...plan,
  name: 'runtime-duplicate-agent-workflow',
  description: 'Workflow preserving duplicate identical agent calls.',
  phases: [
    {
      id: 'Duplicate',
      description: 'Duplicate identical calls',
      prompt: 'Duplicate calls',
      dependsOn: [],
      fanout: 1,
      concurrency: 1,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  totalAgents: 2,
  runScriptSnapshot: duplicateScript,
}
const duplicateResult = await runWorkflowScript({
  script: duplicateScript,
  plan: duplicatePlan,
  context: duplicateContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_duplicate_identity' } } as never,
  workflowRunId: 'wf_duplicate_identity',
  scriptPath: '/tmp/runtime-duplicate-agent-workflow.js',
})
const duplicateTranscriptDirMatch = duplicateResult.match(/Transcript dir: (.+)/)
assert.ok(duplicateTranscriptDirMatch?.[1])
const duplicateResumeResult = await runWorkflowScript({
  script: duplicateScript,
  plan: duplicatePlan,
  context: duplicateContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_duplicate_identity_resume' } } as never,
  workflowRunId: 'wf_duplicate_identity_resume',
  scriptPath: '/tmp/runtime-duplicate-agent-workflow.js',
  resumeFromRunId: 'wf_duplicate_identity',
  resumeJournalEntries: await readWorkflowJournalCacheEntries(duplicateTranscriptDirMatch[1]),
})
const duplicateResumeTranscriptDirMatch = duplicateResumeResult.match(/Transcript dir: (.+)/)
assert.ok(duplicateResumeTranscriptDirMatch?.[1])
const duplicateNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(duplicateNotification)
assert.match(String(duplicateNotification.value), /"first": "duplicate-1"/)
assert.match(String(duplicateNotification.value), /"second": "duplicate-2"/)
assert.equal(duplicateAgentCallCount, 2)

dequeueAllMatching(command => command.mode === 'task-notification')
const editedDuplicateScript = `export const meta = {
  name: "runtime-duplicate-agent-workflow",
  description: "Workflow preserving duplicate identical agent calls.",
  phases: [{ title: "Duplicate", detail: "Duplicate identical calls" }],
}
phase("Duplicate")
const inserted = await agent("new prompt")
const first = await agent("same prompt")
const second = await agent("same prompt")
return { inserted, first, second }
`
await runWorkflowScript({
  script: editedDuplicateScript,
  plan: {
    ...duplicatePlan,
    totalAgents: 3,
    runScriptSnapshot: editedDuplicateScript,
  },
  context: duplicateContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_duplicate_identity_edited_resume' } } as never,
  workflowRunId: 'wf_duplicate_identity_edited_resume',
  scriptPath: '/tmp/runtime-duplicate-agent-workflow.js',
  resumeFromRunId: 'wf_duplicate_identity',
  resumeJournalEntries: await readWorkflowJournalCacheEntries(duplicateTranscriptDirMatch[1]),
})
const editedDuplicateNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(editedDuplicateNotification)
assert.match(String(editedDuplicateNotification.value), /"inserted": "duplicate-3"/)
assert.match(String(editedDuplicateNotification.value), /"first": "duplicate-4"/)
assert.match(String(editedDuplicateNotification.value), /"second": "duplicate-5"/)
assert.equal(duplicateAgentCallCount, 5)

dequeueAllMatching(command => command.mode === 'task-notification')
const vmGlobalScript = `export const meta = {
  name: "runtime-vm-global-workflow",
  description: "Workflow verifying VM global injection.",
  phases: [{ title: "VM", detail: "Global functions" }],
}
if (typeof agent !== "function") throw new Error("agent missing")
if (typeof parallel !== "function") throw new Error("parallel missing")
if (typeof pipeline !== "function") throw new Error("pipeline missing")
if (typeof workflow !== "function") throw new Error("workflow missing")
if (typeof log !== "function") throw new Error("log missing")
if (typeof phase !== "function") throw new Error("phase missing")
let evalBlocked = false
try { eval("1 + 1") } catch { evalBlocked = true }
if (!evalBlocked) throw new Error("eval should be blocked")
return "vm-ok"
`
const vmGlobalPlan: WorkflowDryRunPlan = {
  ...plan,
  name: 'runtime-vm-global-workflow',
  description: 'Workflow verifying VM global injection.',
  phases: [
    {
      id: 'VM',
      description: 'Global functions',
      prompt: 'VM global functions',
      dependsOn: [],
      fanout: 0,
      concurrency: 1,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  totalAgents: 0,
  runScriptSnapshot: vmGlobalScript,
}
await runWorkflowScript({
  script: vmGlobalScript,
  plan: vmGlobalPlan,
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_vm_global_test' } } as never,
  workflowRunId: 'wf_vm_global_test',
  scriptPath: '/tmp/runtime-vm-global-workflow.js',
})
const vmGlobalNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(vmGlobalNotification)
assert.match(String(vmGlobalNotification.value), /vm-ok/)

const childVmDir = await mkdtemp(join(tmpdir(), 'workflow-child-vm-'))
const childVmPath = join(childVmDir, 'child.js')
await writeFile(childVmPath, `export const meta = {
  name: "runtime-child-vm-workflow",
  description: "Child workflow verifying VM code generation restrictions.",
  phases: [{ title: "Child VM", detail: "Function blocked" }],
}
phase("Child VM")
let functionBlocked = false
try { eval("1 + 1") } catch { functionBlocked = true }
if (!functionBlocked) throw new Error("eval should be blocked")
return "child-vm-ok"
`)
const childVmScript = `export const meta = {
  name: "runtime-parent-child-vm-workflow",
  description: "Parent workflow invoking child script VM.",
  phases: [{ title: "Parent VM", detail: "Child VM" }],
}
return await workflow({ scriptPath: ${JSON.stringify(childVmPath)} })
`
await runWorkflowScript({
  script: childVmScript,
  plan: {
    ...vmGlobalPlan,
    name: 'runtime-parent-child-vm-workflow',
    description: 'Parent workflow invoking child script VM.',
    runScriptSnapshot: childVmScript,
  },
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_child_vm_test' } } as never,
  workflowRunId: 'wf_child_vm_test',
  scriptPath: join(childVmDir, 'parent.js'),
})
const childVmTask = Object.values(state.tasks).find(
  task => task.type === 'local_workflow' && task.workflowRunId === 'wf_child_vm_test',
)
assert.ok(childVmTask)
assert.equal(childVmTask.status, 'completed')
const childVmNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(childVmNotification)
assert.match(String(childVmNotification.value), /child-vm-ok/)

const functionResultScript = `export const meta = {
  name: "runtime-function-result-workflow",
  description: "Workflow rejecting function result.",
  phases: [{ title: "VM", detail: "Function result" }],
}
return function leaked() {}
`
const functionResultPlan: WorkflowDryRunPlan = {
  ...vmGlobalPlan,
  name: 'runtime-function-result-workflow',
  description: 'Workflow rejecting function result.',
  runScriptSnapshot: functionResultScript,
}
let functionResultState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const functionResultContext = {
  ...context,
  getAppState: () => functionResultState,
  setAppState: (updater: (prev: AppState) => AppState): void => {
    functionResultState = updater(functionResultState)
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_function_result',
} as unknown as ToolUseContext
await runWorkflowScript({
  script: functionResultScript,
  plan: functionResultPlan,
  context: functionResultContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_function_result_test' } } as never,
  workflowRunId: 'wf_function_result_test',
  scriptPath: '/tmp/runtime-function-result-workflow.js',
})
const functionResultTask = Object.values(functionResultState.tasks).find(
  task => task.type === 'local_workflow',
)
assert.ok(functionResultTask)
assert.equal(functionResultTask.status, 'failed')
assert.match(functionResultTask.error ?? '', /workflow result cannot be a function/)

const unserializableResultScript = `export const meta = {
  name: "runtime-unserializable-result-workflow",
  description: "Workflow failing before completion for unserializable result.",
  phases: [{ title: "VM", detail: "Unserializable result" }],
}
return 1n
`
let unserializableResultState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const unserializableResultCwd = await mkdtemp(join(tmpdir(), 'workflow-unserializable-result-'))
await runWorkflowScript({
  script: unserializableResultScript,
  plan: {
    ...vmGlobalPlan,
    name: 'runtime-unserializable-result-workflow',
    description: 'Workflow failing before completion for unserializable result.',
    runScriptSnapshot: unserializableResultScript,
  },
  context: {
    ...context,
    getCwd: () => unserializableResultCwd,
    getAppState: () => unserializableResultState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      unserializableResultState = updater(unserializableResultState)
    },
    abortController: new AbortController(),
    toolUseId: 'toolu_unserializable_result',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_unserializable_result_test' } } as never,
  workflowRunId: 'wf_unserializable_result_test',
  scriptPath: '/tmp/runtime-unserializable-result-workflow.js',
})
const unserializableResultTask = Object.values(unserializableResultState.tasks).find(
  task => task.type === 'local_workflow',
)
assert.ok(unserializableResultTask)
assert.equal(unserializableResultTask.status, 'failed')
assert.match(unserializableResultTask.error ?? '', /serialize|BigInt|JSON/i)
const unserializableResultSession = await loadWorkflowRunSession({
  cwd: unserializableResultCwd,
  workflowRunId: 'wf_unserializable_result_test',
})
assert.equal(unserializableResultSession?.status, 'failed')

dequeueAllMatching(command => command.mode === 'task-notification')
const retryScript = `export const meta = {
  name: "runtime-retry-agent-workflow",
  description: "Workflow retrying a script agent.",
  phases: [{ title: "Retry", detail: "Retry agent" }],
}
phase("Retry")
return await agent("retry me")
`
const retryPlan: WorkflowDryRunPlan = {
  ...plan,
  name: 'runtime-retry-agent-workflow',
  description: 'Workflow retrying a script agent.',
  phases: [
    {
      id: 'Retry',
      description: 'Retry agent',
      prompt: 'Retry agent',
      dependsOn: [],
      fanout: 1,
      concurrency: 1,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  totalAgents: 1,
  runScriptSnapshot: retryScript,
}
let retryState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setRetryState = (updater: (prev: AppState) => AppState): void => {
  retryState = updater(retryState)
}
let retryCallCount = 0
const retryAgentTool = {
  name: 'Agent',
  async call() {
    retryCallCount++
    if (retryCallCount === 1) {
      const task = Object.values(retryState.tasks).find(
        (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
      )
      assert.ok(task?.currentAgentId)
      retryWorkflowAgent(task.id, task.currentAgentId, setRetryState)
      throw new Error('retry requested')
    }
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'retry-ok' }],
        totalTokens: 1,
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    }
  },
}
const retryContext = {
  getAppState: () => retryState,
  setAppState: setRetryState,
  options: {
    tools: [retryAgentTool],
    mainLoopModel: 'claude-sonnet-4-6',
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_script_retry',
} as unknown as ToolUseContext
await runWorkflowScript({
  script: retryScript,
  plan: retryPlan,
  context: retryContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_retry' } } as never,
  workflowRunId: `wf_script_retry_${process.pid}`,
  scriptPath: '/tmp/runtime-retry-agent-workflow.js',
})
const retryNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(retryNotification)
assert.match(String(retryNotification.value), /retry-ok/)
assert.equal(retryCallCount, 2)

dequeueAllMatching(command => command.mode === 'task-notification')
const skipScript = `export const meta = {
  name: "runtime-skip-agent-workflow",
  description: "Workflow skipping a script agent.",
  phases: [{ title: "Skip", detail: "Skip agent" }],
}
phase("Skip")
return await agent("skip me")
`
let skipState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setSkipState = (updater: (prev: AppState) => AppState): void => {
  skipState = updater(skipState)
}
let skipCallCount = 0
const skipAgentTool = {
  name: 'Agent',
  async call() {
    skipCallCount++
    const task = Object.values(skipState.tasks).find(
      (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
    )
    assert.ok(task?.currentAgentId)
    skipWorkflowAgent(task.id, task.currentAgentId, setSkipState)
    throw new Error('skip requested')
  },
}
await runWorkflowScript({
  script: skipScript,
  plan: {
    ...retryPlan,
    name: 'runtime-skip-agent-workflow',
    description: 'Workflow skipping a script agent.',
    phases: [{ ...retryPlan.phases[0]!, id: 'Skip', description: 'Skip agent', prompt: 'Skip agent' }],
    runScriptSnapshot: skipScript,
  },
  context: {
    ...retryContext,
    getAppState: () => skipState,
    setAppState: setSkipState,
    options: { ...retryContext.options, tools: [skipAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_skip',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_skip' } } as never,
  workflowRunId: `wf_script_skip_${process.pid}`,
  scriptPath: '/tmp/runtime-skip-agent-workflow.js',
})
const skipNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(skipNotification)
assert.match(String(skipNotification.value), /Workflow completed/)
assert.equal(skipCallCount, 1)

const corruptJournalDir = await mkdtemp(join(tmpdir(), 'workflow-corrupt-journal-'))
await writeFile(join(corruptJournalDir, 'journal.jsonl'), '{"type":"result","key":"ok","agentId":"ok","result":"ok","timestamp":1}\n{"type"')
const corruptEntries = await readWorkflowJournalCacheEntries(corruptJournalDir)
assert.equal(corruptEntries.length, 1)
assert.equal(corruptEntries[0]?.result, 'ok')

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
const failedWorkflowRunId = `wf_failed_agent_no_null_${process.pid}`
const failedResult = await runWorkflowScript({
  script: failedScript,
  plan: failedPlan,
  args: { case: 'unit' },
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_failed_agent_test' } } as never,
  workflowRunId: failedWorkflowRunId,
  scriptPath: '/tmp/runtime-failed-agent-workflow.js',
})
const failedTranscriptDirMatch = failedResult.match(/Transcript dir: (.+)/)
assert.ok(failedTranscriptDirMatch?.[1])
const failedJournalRaw = await readFile(join(failedTranscriptDirMatch[1], 'journal.jsonl'), 'utf8')
assert.match(failedJournalRaw, /"type":"started"/)
assert.match(failedJournalRaw, /"agentId":"failed-agent"/)
assert.doesNotMatch(failedJournalRaw, /"type":"result"/)

console.log('workflowScriptRuntime.test.ts passed')
