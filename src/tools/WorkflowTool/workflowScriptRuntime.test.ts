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
import {
  killWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
  workflowPhaseTerminalAgentCount,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

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

const progressEvents = events.filter(event => event.subtype === 'task_progress')
const progress = progressEvents[0]
assert.equal(progress?.task_id, started?.task_id)
assert.equal(progress?.tool_use_id, 'toolu_workflow_test')
assert.equal(progress?.description, 'Parallel: alpha')
assert.equal(progress?.last_tool_name, 'alpha')
assert.equal(
  progressEvents.some(event =>
    event.workflow_progress?.some(item =>
      item.type === 'agent' && item.label === 'alpha' && item.status === 'completed'
    )
  ),
  true,
)

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
  (task): task is LocalWorkflowTaskState =>
    task.type === 'local_workflow' &&
    task.workflowName === 'runtime-small-workflow',
)
assert.ok(workflowTask)
assert.equal(workflowTask.agentCount, 1)
assert.equal(workflowTask.plannedMaxAgents, 1)
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

const changedModeScript = script.replace('{ label: "alpha" }', '{ label: "alpha", mode: "plan" }')
await runWorkflowScript({
  script: changedModeScript,
  plan: {
    ...plan,
    runScriptSnapshot: changedModeScript,
  },
  args: { case: 'unit' },
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_changed_mode_test' } } as never,
  workflowRunId: 'wf_changed_mode_test',
  scriptPath: '/tmp/runtime-small-workflow.js',
  resumeFromRunId: 'wf_test',
  resumeJournalEntries: await readWorkflowJournalCacheEntries(transcriptDirMatch[1]),
})
assert.equal(agentToolCallCount, 2)
dequeueAllMatching(command => command.mode === 'task-notification')

let inheritedModeState = {
  tasks: {},
  toolPermissionContext: { mode: 'plan' },
} as unknown as AppState
let inheritedModeAgentCallCount = 0
const inheritedModeAgentTool = {
  name: 'Agent',
  async call() {
    inheritedModeAgentCallCount++
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: `inherited-mode-${inheritedModeAgentCallCount}` }],
        totalDurationMs: 1,
      },
    }
  },
}
const inheritedModeContext = {
  ...context,
  getAppState: () => inheritedModeState,
  setAppState: (updater: (prev: AppState) => AppState): void => {
    inheritedModeState = updater(inheritedModeState)
  },
  options: {
    ...context.options,
    tools: [inheritedModeAgentTool],
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_inherited_mode',
} as unknown as ToolUseContext
const inheritedModePlan: WorkflowDryRunPlan = {
  ...plan,
  defaults: {
    ...plan.defaults,
    permissionMode: 'default',
  },
  phases: plan.phases.map(phase => ({
    ...phase,
    permissionMode: 'default',
  })),
}
const inheritedModeSourceResult = await runWorkflowScript({
  script,
  plan: inheritedModePlan,
  args: { case: 'unit' },
  context: inheritedModeContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_inherited_mode_source' } } as never,
  workflowRunId: 'wf_inherited_mode_source',
  scriptPath: '/tmp/runtime-small-workflow.js',
})
const inheritedModeTranscriptDirMatch = inheritedModeSourceResult.match(/Transcript dir: (.+)/)
assert.ok(inheritedModeTranscriptDirMatch?.[1])
inheritedModeState = {
  ...inheritedModeState,
  toolPermissionContext: { mode: 'bypassPermissions' },
} as unknown as AppState
await runWorkflowScript({
  script,
  plan: inheritedModePlan,
  args: { case: 'unit' },
  context: inheritedModeContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_inherited_mode_resume' } } as never,
  workflowRunId: 'wf_inherited_mode_resume',
  scriptPath: '/tmp/runtime-small-workflow.js',
  resumeFromRunId: 'wf_inherited_mode_source',
  resumeJournalEntries: await readWorkflowJournalCacheEntries(inheritedModeTranscriptDirMatch[1]),
})
assert.equal(inheritedModeAgentCallCount, 2)
dequeueAllMatching(command => command.mode === 'task-notification')

let queuedDefaultModeState = {
  tasks: {},
  toolPermissionContext: { mode: 'plan' },
} as unknown as AppState
const queuedDefaultModeInputs: Array<{
  prompt?: string
  mode?: string
  inheritedMode?: string
}> = []
let releaseQueuedDefaultModeAgent: (() => void) | undefined
let queuedDefaultModeCalls = 0
const queuedDefaultModeAgentTool = {
  name: 'Agent',
  async call(
    input: { prompt?: string; mode?: string },
    agentContext: ToolUseContext,
  ) {
    queuedDefaultModeInputs.push({
      ...input,
      inheritedMode:
        agentContext.getAppState().toolPermissionContext.mode,
    })
    queuedDefaultModeCalls++
    if (queuedDefaultModeCalls === 1) {
      await new Promise<void>(resolve => {
        releaseQueuedDefaultModeAgent = resolve
      })
    }
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: `queued-default-mode-${queuedDefaultModeCalls}` }],
      },
    }
  },
}
const queuedDefaultModeContext = {
  ...context,
  getAppState: () => queuedDefaultModeState,
  setAppState: (updater: (prev: AppState) => AppState): void => {
    queuedDefaultModeState = updater(queuedDefaultModeState)
  },
  options: {
    ...context.options,
    tools: [queuedDefaultModeAgentTool],
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_queued_default_mode',
} as unknown as ToolUseContext
const queuedDefaultModeScript = `export const meta = {
  name: "runtime-queued-default-mode",
  description: "Snapshot inherited mode before a queued Agent launch.",
  phases: [{ title: "Queued", detail: "Two queued default-mode agents" }],
}
phase("Queued")
return await parallel([
  () => agent("queued-one", { label: "queued-one", mode: "default" }),
  () => agent("queued-two", { label: "queued-two", mode: "default" }),
])
`
const queuedDefaultModeRun = runWorkflowScript({
  script: queuedDefaultModeScript,
  plan: {
    ...inheritedModePlan,
    name: 'runtime-queued-default-mode',
    description: 'Snapshot inherited mode before a queued Agent launch.',
    defaults: {
      ...inheritedModePlan.defaults,
      maxConcurrency: 1,
    },
    phases: [
      {
        ...inheritedModePlan.phases[0]!,
        id: 'Queued',
        description: 'Two queued default-mode agents',
      },
    ],
    totalAgents: 2,
    runScriptSnapshot: queuedDefaultModeScript,
  },
  context: queuedDefaultModeContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_queued_default_mode' } } as never,
  workflowRunId: 'wf_queued_default_mode',
  scriptPath: '/tmp/runtime-queued-default-mode.js',
})
while (!releaseQueuedDefaultModeAgent) {
  await new Promise(resolve => setTimeout(resolve, 0))
}
queuedDefaultModeState = {
  ...queuedDefaultModeState,
  toolPermissionContext: { mode: 'bypassPermissions' },
} as unknown as AppState
releaseQueuedDefaultModeAgent()
await queuedDefaultModeRun
assert.deepEqual(
  queuedDefaultModeInputs
    .map(input => ({
      prompt: input.prompt,
      mode: input.mode,
      inheritedMode: input.inheritedMode,
    }))
    .sort((left, right) =>
      String(left.prompt).localeCompare(String(right.prompt)),
    ),
  [
    {
      prompt: 'queued-one',
      mode: 'plan',
      inheritedMode: 'plan',
    },
    {
      prompt: 'queued-two',
      mode: 'plan',
      inheritedMode: 'plan',
    },
  ],
)
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
  getCwd: () => scriptCwd,
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
const duplicateTask = Object.values(duplicateState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(duplicateTask?.agentCount, 2)
assert.equal(duplicateTask?.plannedMaxAgents, 2)

let duplicateLabelState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const duplicateLabelAgentTool = {
  name: 'Agent',
  async call() {
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'duplicate-label-result' }],
        totalTokens: 1,
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    }
  },
}
const duplicateLabelScript = `export const meta = {
  name: "runtime-duplicate-label-workflow",
  description: "Workflow preserving duplicate explicit labels.",
  phases: [{ title: "Duplicate", detail: "Duplicate labels" }],
}
phase("Duplicate")
return await parallel([
  () => agent("first", { label: "same" }),
  () => agent("second", { label: "same" }),
])
`
await runWorkflowScript({
  script: duplicateLabelScript,
  plan: {
    ...duplicatePlan,
    name: 'runtime-duplicate-label-workflow',
    description: 'Workflow preserving duplicate explicit labels.',
    runScriptSnapshot: duplicateLabelScript,
  },
  context: {
    ...duplicateContext,
    getAppState: () => duplicateLabelState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      duplicateLabelState = updater(duplicateLabelState)
    },
    options: {
      ...duplicateContext.options,
      tools: [duplicateLabelAgentTool],
    },
    abortController: new AbortController(),
    toolUseId: 'toolu_duplicate_label_identity',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_duplicate_label_identity' } } as never,
  workflowRunId: 'wf_duplicate_label_identity',
  scriptPath: '/tmp/runtime-duplicate-label-workflow.js',
})
const duplicateLabelTask = Object.values(duplicateLabelState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(duplicateLabelTask?.agentCount, 2)
assert.deepEqual(duplicateLabelTask?.phases[0]?.agentIds, ['same', 'same [2]'])
dequeueAllMatching(command => command.mode === 'task-notification')

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

let parallelIdentityState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
let parallelIdentityCalls = 0
const parallelIdentityAgentTool = {
  name: 'Agent',
  async call(input: { prompt?: string }) {
    parallelIdentityCalls++
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: `${input.prompt}-result` }],
        totalTokens: 1,
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    }
  },
}
const parallelIdentityContext = {
  ...duplicateContext,
  getAppState: () => parallelIdentityState,
  setAppState: (updater: (prev: AppState) => AppState): void => {
    parallelIdentityState = updater(parallelIdentityState)
  },
  options: {
    ...duplicateContext.options,
    tools: [parallelIdentityAgentTool],
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_parallel_identity',
} as unknown as ToolUseContext
const parallelIdentityScript = `export const meta = {
  name: "runtime-parallel-identity",
  description: "Stable parallel resume identities.",
  phases: [{ title: "Parallel", detail: "Two parallel agents" }],
}
phase("Parallel")
return await parallel([
  async () => {
    if (args.delayFirst) {
      await Promise.resolve()
    }
    return agent("first", { label: "first" })
  },
  async () => {
    if (!args.delayFirst) {
      await Promise.resolve()
    }
    return agent("second", { label: "second" })
  },
])
`
const parallelIdentityPlan: WorkflowDryRunPlan = {
  ...duplicatePlan,
  name: 'runtime-parallel-identity',
  description: 'Stable parallel resume identities.',
  phases: [{
    ...duplicatePlan.phases[0]!,
    id: 'Parallel',
    description: 'Two parallel agents',
    fanout: 2,
    concurrency: 2,
    agentLabels: ['first', 'second'],
  }],
  totalAgents: 2,
  runScriptSnapshot: parallelIdentityScript,
}
const parallelIdentityResult = await runWorkflowScript({
  script: parallelIdentityScript,
  plan: parallelIdentityPlan,
  args: { delayFirst: true },
  context: parallelIdentityContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_parallel_identity' } } as never,
  workflowRunId: 'wf_parallel_identity',
  scriptPath: '/tmp/runtime-parallel-identity.js',
})
const parallelIdentityTranscriptDir = parallelIdentityResult.match(
  /Transcript dir: (.+)/,
)?.[1]
assert.ok(parallelIdentityTranscriptDir)
await runWorkflowScript({
  script: parallelIdentityScript,
  plan: parallelIdentityPlan,
  args: { delayFirst: false },
  context: parallelIdentityContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_parallel_identity_resume' } } as never,
  workflowRunId: 'wf_parallel_identity_resume',
  scriptPath: '/tmp/runtime-parallel-identity.js',
  resumeFromRunId: 'wf_parallel_identity',
  resumeJournalEntries: await readWorkflowJournalCacheEntries(
    parallelIdentityTranscriptDir,
  ),
})
assert.equal(parallelIdentityCalls, 2)
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
drainSdkEvents()
dequeueAllMatching(command => command.mode === 'task-notification')
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
const functionResultNotification = dequeue(
  command =>
    command.mode === 'task-notification' &&
    String(command.value).includes(functionResultTask.id),
)
assert.ok(functionResultNotification)
assert.match(String(functionResultNotification.value), /<status>failed<\/status>/)
const functionResultSdkNotification = drainSdkEvents().find(
  event =>
    event.subtype === 'task_notification' &&
    event.task_id === functionResultTask.id,
)
assert.equal(
  functionResultSdkNotification?.subtype === 'task_notification'
    ? functionResultSdkNotification.status
    : undefined,
  'failed',
)

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
  getCwd: () => scriptCwd,
  options: {
    tools: [retryAgentTool],
    mainLoopModel: 'claude-sonnet-4-6',
    workflowRunInForeground: true,
  },
  abortController: new AbortController(),
  toolUseId: 'toolu_script_retry',
} as unknown as ToolUseContext
const retryWorkflowRunId = `wf_script_retry_${process.pid}`
const retryResult = await runWorkflowScript({
  script: retryScript,
  plan: retryPlan,
  context: retryContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_retry' } } as never,
  workflowRunId: retryWorkflowRunId,
  scriptPath: '/tmp/runtime-retry-agent-workflow.js',
})
const retryNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(retryNotification)
assert.match(String(retryNotification.value), /retry-ok/)
assert.equal(retryCallCount, 2)
const retryTask = Object.values(retryState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(retryTask?.agentCount, 1)
assert.equal(retryTask?.startedAgentAttempts, 2)
assert.equal(retryTask?.retryCount, 1)
assert.deepEqual(retryTask?.agentAttempts.map(attempt => ({
  agentId: attempt.agentId,
  attempt: attempt.attempt,
  retryOfAttemptId: attempt.retryOfAttemptId,
  status: attempt.status,
})), [
  {
    agentId: 'agent-1',
    attempt: 0,
    retryOfAttemptId: undefined,
    status: 'interrupted',
  },
  {
    agentId: 'agent-1 (retry 1)',
    attempt: 1,
    retryOfAttemptId: 'Retry:agent-1:attempt:0',
    status: 'completed',
  },
])
assert.deepEqual(retryTask?.phases[0]?.agentIds, ['agent-1 (retry 1)'])
assert.deepEqual(retryTask?.phases[0]?.completedAgentIds, ['agent-1 (retry 1)'])
const retryTranscriptDirMatch = retryResult.match(/Transcript dir: (.+)/)
assert.ok(retryTranscriptDirMatch?.[1])
const retryJournalRaw = await readFile(join(retryTranscriptDirMatch[1], 'journal.jsonl'), 'utf8')
assert.match(retryJournalRaw, /"agentId":"agent-1".*"attemptId":"Retry:agent-1:attempt:0"/)
assert.match(retryJournalRaw, /"agentId":"agent-1".*"status":"interrupted"/)
assert.match(retryJournalRaw, /"agentId":"agent-1 \(retry 1\)".*"attemptId":"Retry:agent-1:attempt:1"/)
assert.match(retryJournalRaw, /"retryOfAttemptId":"Retry:agent-1:attempt:0"/)
assert.equal((await readWorkflowJournalCacheEntries(retryTranscriptDirMatch[1])).length, 1)

let automaticRetryState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
let automaticRetryCallCount = 0
let automaticRetryStartedCleanly = false
const automaticRetryAgentTool = {
  name: 'Agent',
  async call() {
    automaticRetryCallCount++
    if (automaticRetryCallCount === 1) {
      throw new Error('stalled')
    }
    const runningTask = Object.values(automaticRetryState.tasks).find(
      (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
    )
    automaticRetryStartedCleanly =
      runningTask?.liveAgents?.['agent-1'] === undefined &&
      runningTask?.agentControllers?.['agent-1'] === undefined &&
      runningTask?.liveAgents?.['agent-1 (retry 1)'] !== undefined &&
      runningTask?.agentControllers?.['agent-1 (retry 1)'] !== undefined
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'automatic-retry-ok' }],
        totalTokens: 1,
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    }
  },
}
await runWorkflowScript({
  script: retryScript,
  plan: {
    ...retryPlan,
    name: 'runtime-automatic-retry-agent-workflow',
    defaults: { ...retryPlan.defaults, maxRetries: 1 },
  },
  context: {
    ...retryContext,
    getAppState: () => automaticRetryState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      automaticRetryState = updater(automaticRetryState)
    },
    options: { ...retryContext.options, tools: [automaticRetryAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_automatic_retry',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_automatic_retry' } } as never,
  workflowRunId: `wf_script_automatic_retry_${process.pid}`,
  scriptPath: '/tmp/runtime-automatic-retry-agent-workflow.js',
})
assert.equal(automaticRetryCallCount, 2)
assert.equal(automaticRetryStartedCleanly, true)
const automaticRetryTask = Object.values(automaticRetryState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(automaticRetryTask?.startedAgentAttempts, 2)
assert.equal(automaticRetryTask?.retryCount, 1)
assert.deepEqual(automaticRetryTask?.phases[0]?.agentIds, ['agent-1 (retry 1)'])
dequeueAllMatching(command => command.mode === 'task-notification')

let schemaState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const schemaToolsSeen: string[][] = []
const schemaAgentTool = {
  name: 'Agent',
  async call(_input: unknown, agentContext: ToolUseContext) {
    schemaToolsSeen.push(agentContext.options.tools.map(tool => tool.name))
    const structuredOutputTool = agentContext.options.tools.find(
      tool => tool.name === 'StructuredOutput',
    )
    assert.ok(structuredOutputTool)
    const structuredOutput = await structuredOutputTool.call(
      { ok: true },
      agentContext,
      async () => ({ behavior: 'allow' }),
      { message: { id: 'msg_schema_output' } } as never,
    ) as { structured_output?: unknown }
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'structured output returned' }],
        structured_output: structuredOutput.structured_output,
      },
    }
  },
}
const schemaScript = `export const meta = {
  name: "runtime-schema-agent-workflow",
  description: "Workflow using schema output.",
  phases: [{ title: "Schema", detail: "Schema agent" }],
}
phase("Schema")
return await agent("return schema", {
  label: "schema-agent",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  },
})
`
await runWorkflowScript({
  script: schemaScript,
  plan: {
    ...retryPlan,
    name: 'runtime-schema-agent-workflow',
    description: 'Workflow using schema output.',
    phases: [{ ...retryPlan.phases[0]!, id: 'Schema', description: 'Schema agent', prompt: 'Schema agent' }],
    runScriptSnapshot: schemaScript,
  },
  context: {
    ...retryContext,
    getAppState: () => schemaState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      schemaState = updater(schemaState)
    },
    options: { ...retryContext.options, tools: [schemaAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_schema',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_schema' } } as never,
  workflowRunId: `wf_script_schema_${process.pid}`,
  scriptPath: '/tmp/runtime-schema-agent-workflow.js',
})
assert.equal(schemaToolsSeen.length, 1)
assert.ok(schemaToolsSeen[0]?.includes('StructuredOutput'))
const schemaTask = Object.values(schemaState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(schemaTask?.status, 'completed')
assert.deepEqual(JSON.parse(schemaTask?.results[0]?.output ?? 'null'), { ok: true })
dequeueAllMatching(command => command.mode === 'task-notification')

let invalidSchemaState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const invalidSchemaAgentTool = {
  name: 'Agent',
  async call(_input: unknown, agentContext: ToolUseContext) {
    const structuredOutputTool = agentContext.options.tools.find(
      tool => tool.name === 'StructuredOutput',
    )
    assert.ok(structuredOutputTool)
    await structuredOutputTool.call(
      { ok: 'not-a-boolean' },
      agentContext,
      async () => ({ behavior: 'allow' }),
      { message: { id: 'msg_invalid_schema_output' } } as never,
    )
    throw new Error('StructuredOutput unexpectedly accepted an invalid payload')
  },
}
const invalidSchemaResult = await runWorkflowScript({
  script: schemaScript,
  plan: {
    ...retryPlan,
    name: 'runtime-invalid-schema-agent-workflow',
    description: 'Workflow rejecting invalid schema output.',
    phases: [{ ...retryPlan.phases[0]!, id: 'Schema', description: 'Schema agent', prompt: 'Schema agent' }],
    runScriptSnapshot: schemaScript,
  },
  context: {
    ...retryContext,
    getAppState: () => invalidSchemaState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      invalidSchemaState = updater(invalidSchemaState)
    },
    options: { ...retryContext.options, tools: [invalidSchemaAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_invalid_schema',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_invalid_schema' } } as never,
  workflowRunId: `wf_script_invalid_schema_${process.pid}`,
  scriptPath: '/tmp/runtime-invalid-schema-agent-workflow.js',
})
const invalidSchemaTask = Object.values(invalidSchemaState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(invalidSchemaTask?.phases[0]?.completedAgentIds.length, 0)
assert.equal(invalidSchemaTask?.phases[0]?.failedAgentIds.length, 1)
const invalidSchemaTranscriptDir = invalidSchemaResult.match(/Transcript dir: (.+)/)?.[1]
assert.ok(invalidSchemaTranscriptDir)
assert.equal((await readWorkflowJournalCacheEntries(invalidSchemaTranscriptDir)).length, 0)
dequeueAllMatching(command => command.mode === 'task-notification')

let missingSchemaState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const missingSchemaAgentTool = {
  name: 'Agent',
  async call() {
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: '{"ok":true}' }],
      },
    }
  },
}
await runWorkflowScript({
  script: schemaScript,
  plan: {
    ...retryPlan,
    name: 'runtime-missing-schema-agent-workflow',
    description: 'Workflow missing schema output.',
    phases: [{ ...retryPlan.phases[0]!, id: 'Schema', description: 'Schema agent', prompt: 'Schema agent' }],
    runScriptSnapshot: schemaScript,
  },
  context: {
    ...retryContext,
    getAppState: () => missingSchemaState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      missingSchemaState = updater(missingSchemaState)
    },
    options: { ...retryContext.options, tools: [missingSchemaAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_missing_schema',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_missing_schema' } } as never,
  workflowRunId: `wf_script_missing_schema_${process.pid}`,
  scriptPath: '/tmp/runtime-missing-schema-agent-workflow.js',
})
const missingSchemaTask = Object.values(missingSchemaState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(missingSchemaTask?.status, 'completed')
assert.equal(missingSchemaTask?.phases[0]?.completedAgentIds.length, 0)
assert.equal(missingSchemaTask?.phases[0]?.failedAgentIds.length, 1)

dequeueAllMatching(command => command.mode === 'task-notification')
const multiPhaseScript = `export const meta = {
  name: "runtime-multi-phase-workflow",
  description: "Workflow using phase-local agent indexes.",
  phases: [{ title: "First" }, { title: "Second" }],
}
phase("First")
await agent("first", { label: "first-agent" })
phase("Second")
await agent("second", { label: "second-agent" })
`
let multiPhaseState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
await runWorkflowScript({
  script: multiPhaseScript,
  plan: {
    ...plan,
    name: 'runtime-multi-phase-workflow',
    description: 'Workflow using phase-local agent indexes.',
    phases: [
      { ...plan.phases[0]!, id: 'First' },
      { ...plan.phases[0]!, id: 'Second' },
    ],
    totalAgents: 2,
    runScriptSnapshot: multiPhaseScript,
  },
  context: {
    ...context,
    getAppState: () => multiPhaseState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      multiPhaseState = updater(multiPhaseState)
    },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_multi_phase',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_multi_phase' } } as never,
  workflowRunId: `wf_script_multi_phase_${process.pid}`,
  scriptPath: '/tmp/runtime-multi-phase-workflow.js',
})
const multiPhaseTask = Object.values(multiPhaseState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.ok(multiPhaseTask)
assert.deepEqual(
  multiPhaseTask.phases.map(phase => ({
    agentIds: phase.agentIds,
    resultIndexes: phase.results.map(result => result.index),
    terminalCount: workflowPhaseTerminalAgentCount(phase),
  })),
  [
    { agentIds: ['first-agent'], resultIndexes: [0], terminalCount: 1 },
    { agentIds: ['second-agent'], resultIndexes: [0], terminalCount: 1 },
  ],
)

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
await writeFile(join(corruptJournalDir, 'journal.jsonl'), '{"type":"result","key":"ok","agentId":"ok","status":"completed","result":"ok","timestamp":1}\n{"type"')
const corruptEntries = await readWorkflowJournalCacheEntries(corruptJournalDir)
assert.equal(corruptEntries.length, 1)
assert.equal(corruptEntries[0]?.result, 'ok')

const failedScript = `export const meta = {
  name: "runtime-failed-agent-workflow",
  description: "Workflow recording failed agent null result.",
  phases: [{ title: "Fail", detail: "Failing agent" }],
}
phase("Fail")
return await parallel([
  () => agent("fail-agent", { label: "failed-agent-a" }),
  () => agent("fail-agent", { label: "failed-agent-b" }),
])
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
      fanout: 2,
      concurrency: 2,
      review: 'none',
      permissionMode: 'bypassPermissions',
    },
  ],
  totalAgents: 2,
  runScriptSnapshot: failedScript,
}
const failedWorkflowRunId = `wf_failed_agent_no_null_${process.pid}`
const failedCallCountBefore = agentToolCallCount
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
assert.match(failedJournalRaw, /"agentId":"failed-agent-a"/)
assert.match(failedJournalRaw, /"agentId":"failed-agent-b"/)
assert.match(failedJournalRaw, /"type":"result"/)
assert.match(failedJournalRaw, /"status":"failed"/)
assert.match(failedJournalRaw, /"errorKind":"agent_failed"/)
assert.equal(agentToolCallCount, failedCallCountBefore + 2)
assert.doesNotMatch(failedJournalRaw, /"retryOfAttemptId"/)
assert.equal((await readWorkflowJournalCacheEntries(failedTranscriptDirMatch[1])).length, 0)
const failedTask = Object.values(state.tasks).find(
  (task): task is LocalWorkflowTaskState =>
    task.type === 'local_workflow' && task.workflowRunId === failedWorkflowRunId,
)
assert.equal(failedTask?.agentCount, 2)
assert.equal(failedTask?.startedAgentAttempts, 2)
assert.equal(failedTask?.retryCount, 0)
assert.deepEqual(failedTask?.results.map(result => ({
  agentId: result.agentId,
  index: result.index,
  status: result.status,
})).sort((left, right) => left.index - right.index), [
  { agentId: 'failed-agent-a', index: 0, status: 'failed' },
  { agentId: 'failed-agent-b', index: 1, status: 'failed' },
])
assert.deepEqual(failedTask?.agentAttempts.map(attempt => ({
  agentId: attempt.agentId,
  attempt: attempt.attempt,
  status: attempt.status,
})).sort((left, right) => left.agentId.localeCompare(right.agentId)), [
  { agentId: 'failed-agent-a', attempt: 0, status: 'failed' },
  { agentId: 'failed-agent-b', attempt: 0, status: 'failed' },
])

drainSdkEvents()
dequeueAllMatching(command => command.mode === 'task-notification')
const killedScript = `export const meta = {
  name: "runtime-killed-workflow",
  description: "Workflow emitting a stopped terminal event when killed.",
  phases: [{ title: "Kill", detail: "Kill running agent" }],
}
phase("Kill")
return await parallel(Array.from({ length: 20 }, (_, index) =>
  () => agent(\`wait for kill \${index}\`),
))
`
let killedState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setKilledState = (updater: (prev: AppState) => AppState): void => {
  killedState = updater(killedState)
}
let killedAgentCallCount = 0
const killedAgentTool = {
  name: 'Agent',
  async call() {
    killedAgentCallCount++
    const task = Object.values(killedState.tasks).find(
      (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
    )
    assert.ok(task)
    if (task.status === 'running') {
      killWorkflowTask(task.id, setKilledState)
      throw new Error('killed by test')
    }
    throw new Error('agent launched after workflow kill')
  },
}
await runWorkflowScript({
  script: killedScript,
  plan: {
    ...retryPlan,
    name: 'runtime-killed-workflow',
    description: 'Workflow emitting a stopped terminal event when killed.',
    phases: [{ ...retryPlan.phases[0]!, id: 'Kill', description: 'Kill running agent', prompt: 'Kill running agent' }],
    totalAgents: 20,
    runScriptSnapshot: killedScript,
  },
  context: {
    ...retryContext,
    getAppState: () => killedState,
    setAppState: setKilledState,
    options: { ...retryContext.options, tools: [killedAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_killed',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_killed' } } as never,
  workflowRunId: `wf_script_killed_${process.pid}`,
  scriptPath: '/tmp/runtime-killed-workflow.js',
})
const killedTask = Object.values(killedState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.ok(killedTask)
assert.equal(killedTask.status, 'killed')
assert.equal(killedAgentCallCount, 1)
const killedSdkNotification = drainSdkEvents().find(
  event =>
    event.subtype === 'task_notification' && event.task_id === killedTask.id,
)
assert.equal(
  killedSdkNotification?.subtype === 'task_notification'
    ? killedSdkNotification.status
    : undefined,
  'stopped',
)

const largeFanoutCount = 1_001
const largeFanoutScript = `export const meta = {
  name: "runtime-large-fanout-workflow",
  description: "Workflow with bounded large fanout.",
  phases: [{ title: "Fanout", detail: "Run many agents" }],
}
phase("Fanout")
return await parallel(Array.from({ length: ${largeFanoutCount} }, (_, index) =>
  () => agent(\`fanout \${index}\`),
))
`
let largeFanoutState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setLargeFanoutState = (updater: (prev: AppState) => AppState): void => {
  largeFanoutState = updater(largeFanoutState)
}
let largeFanoutCalls = 0
let activeLargeFanoutCalls = 0
let maxActiveLargeFanoutCalls = 0
const largeFanoutAgentTool = {
  name: 'Agent',
  async call() {
    largeFanoutCalls++
    activeLargeFanoutCalls++
    maxActiveLargeFanoutCalls = Math.max(
      maxActiveLargeFanoutCalls,
      activeLargeFanoutCalls,
    )
    await Promise.resolve()
    activeLargeFanoutCalls--
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'ok' }],
        totalDurationMs: 1,
      },
    }
  },
}
await runWorkflowScript({
  script: largeFanoutScript,
  plan: {
    ...retryPlan,
    name: 'runtime-large-fanout-workflow',
    description: 'Workflow with bounded large fanout.',
    phases: [{
      ...retryPlan.phases[0]!,
      id: 'Fanout',
      description: 'Run many agents',
      prompt: 'Run many agents',
      fanout: largeFanoutCount,
      concurrency: 16,
    }],
    totalAgents: largeFanoutCount,
    runScriptSnapshot: largeFanoutScript,
  },
  context: {
    ...retryContext,
    getAppState: () => largeFanoutState,
    setAppState: setLargeFanoutState,
    options: { ...retryContext.options, tools: [largeFanoutAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_large_fanout',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_large_fanout' } } as never,
  workflowRunId: `wf_script_large_fanout_${process.pid}`,
  scriptPath: '/tmp/runtime-large-fanout-workflow.js',
})
assert.equal(largeFanoutCalls, largeFanoutCount)
assert.equal(maxActiveLargeFanoutCalls <= 16, true)
const largeFanoutTask = Object.values(largeFanoutState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(largeFanoutTask?.agentCount, largeFanoutCount)

console.log('workflowScriptRuntime.test.ts passed')
