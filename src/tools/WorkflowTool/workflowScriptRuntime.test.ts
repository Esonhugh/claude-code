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
import { runWorkflowScript } from './workflowScriptRuntime.js'
import type { WorkflowDryRunPlan } from './workflowSpec.js'
import {
  classifyWorkflowAgentError,
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
  classifyWorkflowAgentError(new Error('request timed out after 30s')),
  'timeout',
)

assert.equal(
  classifyWorkflowAgentError(new Error('network connection reset by peer')),
  'network',
)

assert.equal(
  classifyWorkflowAgentError(new Error('429 too many requests')),
  'rate_limited',
)

assert.equal(
  classifyWorkflowAgentError(new Error('503 service temporarily unavailable')),
  'service_unavailable',
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
    if (
      typeof _input === 'object' &&
      _input &&
      'prompt' in _input &&
      _input.prompt === 'prompt-too-long-agent'
    ) {
      onProgress?.({
        data: {
          type: 'agent_progress',
          message: {
            type: 'assistant',
            uuid: '00000000-0000-4000-8000-000000000013',
            timestamp: '2026-07-14T00:00:00.000Z',
            message: {
              id: 'msg_prompt_too_long_progress',
              role: 'assistant',
              model: 'claude-test',
              content: Array.from({ length: 12 }, (_, index) => ({
                type: 'tool_use',
                id: `toolu_prompt_too_long_${index + 1}`,
                name: 'Read',
                input: { file_path: `fixture-${index + 1}.txt` },
              })),
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: {
                input_tokens: 173_000,
                output_tokens: 379,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
        },
      })
      throw new Error('Prompt is too long')
    }
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
      mode: undefined,
      inheritedMode: 'plan',
    },
    {
      prompt: 'queued-two',
      mode: undefined,
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

drainSdkEvents()
dequeueAllMatching(command => command.mode === 'task-notification')
const userRetryUsageScript = `export const meta = {
  name: "runtime-user-retry-usage-workflow",
  description: "Workflow preserving user retry attempt usage.",
  phases: [{ title: "Retry", detail: "User retry usage agent" }],
}
phase("Retry")
const result = await agent("user-retry-usage-agent", { label: "user-retry-usage-agent" })
return { result, spent: budget.spent() }
`
let userRetryUsageState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setUserRetryUsageState = (updater: (prev: AppState) => AppState): void => {
  userRetryUsageState = updater(userRetryUsageState)
}
let userRetryUsageCallCount = 0
let userRetryUsageRetriedAgentId: string | undefined
let userRetryUsageAbortReason: unknown
const userRetryUsageAgentTool = {
  name: 'Agent',
  async call(
    _input: unknown,
    agentContext: ToolUseContext,
    _canUseTool: unknown,
    _assistantMessage: unknown,
    onProgress?: (progress: unknown) => void,
  ) {
    userRetryUsageCallCount++
    if (userRetryUsageCallCount === 1) {
      onProgress?.({
        data: {
          type: 'agent_progress',
          message: {
            type: 'assistant',
            uuid: '00000000-0000-4000-8000-000000000017',
            timestamp: '2026-07-14T00:00:00.000Z',
            message: {
              id: 'msg_user_retry_usage_first_progress',
              role: 'assistant',
              model: 'claude-test',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_user_retry_usage_first_1',
                  name: 'Read',
                  input: { file_path: 'user-retry-first.txt' },
                },
              ],
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: {
                input_tokens: 10,
                output_tokens: 1,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
        },
      })
      const task = Object.values(userRetryUsageState.tasks).find(
        (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
      )
      assert.ok(task?.currentAgentId)
      userRetryUsageRetriedAgentId = task.currentAgentId
      retryWorkflowAgent(task.id, task.currentAgentId, setUserRetryUsageState)
      userRetryUsageAbortReason = agentContext.abortController.signal.reason
      throw new Error('retry requested')
    }
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'user-retry-usage-ok' }],
        totalTokens: 20,
        totalToolUseCount: 2,
        totalDurationMs: 1,
      },
    }
  },
}
const userRetryUsageWorkflowRunId = `wf_script_user_retry_usage_${process.pid}`
const userRetryUsageResult = await runWorkflowScript({
  script: userRetryUsageScript,
  plan: {
    ...retryPlan,
    name: 'runtime-user-retry-usage-workflow',
    description: 'Workflow preserving user retry attempt usage.',
    phases: [{ ...retryPlan.phases[0]!, id: 'Retry', description: 'User retry usage agent', prompt: 'User retry usage agent' }],
    runScriptSnapshot: userRetryUsageScript,
  },
  context: {
    ...retryContext,
    getAppState: () => userRetryUsageState,
    setAppState: setUserRetryUsageState,
    options: { ...retryContext.options, tools: [userRetryUsageAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_user_retry_usage',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_user_retry_usage' } } as never,
  workflowRunId: userRetryUsageWorkflowRunId,
  scriptPath: '/tmp/runtime-user-retry-usage-workflow.js',
})
assert.equal(userRetryUsageCallCount, 2)
const userRetryUsageTask = Object.values(userRetryUsageState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.ok(userRetryUsageTask)
const userRetryUsageEvents = drainSdkEvents()
const userRetryUsageSdkTermination = userRetryUsageEvents.find(
  event =>
    event.subtype === 'task_notification' &&
    event.task_id === userRetryUsageTask.id,
)
assert.equal(userRetryUsageSdkTermination?.subtype, 'task_notification')
assert.ok(userRetryUsageSdkTermination.output_file)
const userRetryUsageOutput = await readFile(
  userRetryUsageSdkTermination.output_file,
  'utf8',
)
const userRetryUsageSession = await loadWorkflowRunSession({
  cwd: scriptCwd,
  workflowRunId: userRetryUsageWorkflowRunId,
})
assert.deepEqual({
  retriedAgentId: userRetryUsageRetriedAgentId,
  abortReason: userRetryUsageAbortReason,
  taskTokens: userRetryUsageTask.tokenCount,
  taskToolUses: userRetryUsageTask.toolUseCount,
  sessionTokens: userRetryUsageSession?.tokenCount,
  sessionToolUses: userRetryUsageSession?.toolUseCount,
  sdkTokens: userRetryUsageSdkTermination?.usage?.total_tokens,
  sdkToolUses: userRetryUsageSdkTermination?.usage?.tool_uses,
  scriptSpent: Number(userRetryUsageOutput.match(/"spent":\s*(\d+)/)?.[1]),
  sessionResultTokens: userRetryUsageSession?.results[0]?.tokenCount,
  sessionResultToolUses: userRetryUsageSession?.results[0]?.toolUseCount,
}, {
  retriedAgentId: 'user-retry-usage-agent',
  abortReason: 'user-retry',
  taskTokens: 31,
  taskToolUses: 3,
  sessionTokens: 31,
  sessionToolUses: 3,
  sdkTokens: 31,
  sdkToolUses: 3,
  scriptSpent: 31,
  sessionResultTokens: 20,
  sessionResultToolUses: 2,
})
const userRetryUsageTranscriptDir = userRetryUsageResult.match(/Transcript dir: (.+)/)?.[1]
assert.ok(userRetryUsageTranscriptDir)
const userRetryUsageJournalRaw = await readFile(join(userRetryUsageTranscriptDir, 'journal.jsonl'), 'utf8')
const userRetryUsageJournalEntries = userRetryUsageJournalRaw
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as Record<string, unknown>)
const userRetryUsageAttempt0Id = 'Retry:user-retry-usage-agent:attempt:0'
const userRetryUsageRetryAttemptId = 'Retry:user-retry-usage-agent:attempt:1'
const userRetryUsageInterruptedEntry = userRetryUsageJournalEntries.find(
  entry =>
    entry.type === 'result' &&
    entry.attemptId === userRetryUsageAttempt0Id &&
    entry.status === 'interrupted',
)
const userRetryUsageRetrySuccessEntry = userRetryUsageJournalEntries.find(
  entry =>
    entry.type === 'result' &&
    entry.attemptId === userRetryUsageRetryAttemptId &&
    entry.retryOfAttemptId === userRetryUsageAttempt0Id &&
    entry.status === 'completed',
)
const userRetryUsageJournalCacheEntries = await readWorkflowJournalCacheEntries(userRetryUsageTranscriptDir)
assert.deepEqual({
  interruptedStatus: userRetryUsageInterruptedEntry?.status,
  interruptedTokens: userRetryUsageInterruptedEntry?.tokenCount,
  interruptedToolUses: userRetryUsageInterruptedEntry?.toolUseCount,
  attempt0HasFailedResult: userRetryUsageJournalEntries.some(
    entry =>
      entry.type === 'result' &&
      entry.attemptId === userRetryUsageAttempt0Id &&
      entry.status === 'failed',
  ),
  retrySuccessExists: Boolean(userRetryUsageRetrySuccessEntry),
  cacheEntryCount: userRetryUsageJournalCacheEntries.length,
  cacheHasInterruptedResult: userRetryUsageJournalCacheEntries.some(entry => entry.result === null),
}, {
  interruptedStatus: 'interrupted',
  interruptedTokens: 11,
  interruptedToolUses: 1,
  attempt0HasFailedResult: false,
  retrySuccessExists: true,
  cacheEntryCount: 1,
  cacheHasInterruptedResult: false,
})
assert.match(userRetryUsageResult, /runtime-user-retry-usage-workflow/)
dequeueAllMatching(command => command.mode === 'task-notification')

drainSdkEvents()
const parallelUserRetryScript = `export const meta = {
  name: "runtime-parallel-user-retry-usage-workflow",
  description: "Workflow preserving parallel user retry attempt usage.",
  phases: [{ title: "Retry", detail: "Parallel user retry usage agents" }],
}
phase("Retry")
const [retried, neighbor] = await parallel([
  () => agent("parallel-user-retry-agent", { label: "parallel-user-retry-agent" }),
  () => agent("parallel-other-agent", { label: "parallel-other-agent" }),
])
return { retried, neighbor, spent: budget.spent() }
`
let parallelUserRetryState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setParallelUserRetryState = (updater: (prev: AppState) => AppState): void => {
  parallelUserRetryState = updater(parallelUserRetryState)
}
const parallelUserRetryCallCounts = new Map<string, number>()
let parallelUserRetryRequested = false
let releaseParallelUserRetryFirstAttempts: (() => void) | undefined
const parallelUserRetryFirstAttemptsReady = new Promise<void>(resolve => {
  releaseParallelUserRetryFirstAttempts = resolve
})
const maybeRequestParallelUserRetries = () => {
  if (parallelUserRetryRequested) return
  const task = Object.values(parallelUserRetryState.tasks).find(
    (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
  )
  if (
    !task?.agentControllers?.['parallel-user-retry-agent'] ||
    !task.agentControllers['parallel-other-agent']
  ) {
    return
  }
  parallelUserRetryRequested = true
  retryWorkflowAgent(task.id, 'parallel-user-retry-agent', setParallelUserRetryState)
  retryWorkflowAgent(task.id, 'parallel-other-agent', setParallelUserRetryState)
  releaseParallelUserRetryFirstAttempts?.()
}
const parallelUserRetryProgress = (
  messageId: string,
  inputTokens: number,
  outputTokens: number,
  toolIds: string[],
) => ({
  data: {
    type: 'agent_progress',
    message: {
      type: 'assistant',
      uuid: `00000000-0000-4000-8000-${messageId.padStart(12, '0')}`,
      timestamp: '2026-07-14T00:00:00.000Z',
      message: {
        id: `msg_parallel_user_retry_${messageId}`,
        role: 'assistant',
        model: 'claude-test',
        content: toolIds.map(toolId => ({
          type: 'tool_use',
          id: toolId,
          name: 'Read',
          input: { file_path: `${toolId}.txt` },
        })),
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    },
  },
})
const parallelUserRetryAgentTool = {
  name: 'Agent',
  async call(
    input: { prompt?: string },
    _agentContext: ToolUseContext,
    _canUseTool: unknown,
    _assistantMessage: unknown,
    onProgress?: (progress: unknown) => void,
  ) {
    const prompt = input.prompt ?? ''
    const callCount = (parallelUserRetryCallCounts.get(prompt) ?? 0) + 1
    parallelUserRetryCallCounts.set(prompt, callCount)
    if (callCount === 1) {
      if (prompt === 'parallel-user-retry-agent') {
        onProgress?.(parallelUserRetryProgress(
          '21',
          10,
          1,
          ['toolu_parallel_user_retry_target_first'],
        ))
      } else {
        onProgress?.(parallelUserRetryProgress(
          '22',
          100,
          4,
          [
            'toolu_parallel_user_retry_other_first_1',
            'toolu_parallel_user_retry_other_first_2',
          ],
        ))
      }
      maybeRequestParallelUserRetries()
      if (!parallelUserRetryRequested) {
        await parallelUserRetryFirstAttemptsReady
      } else if (prompt === 'parallel-other-agent') {
        await Promise.resolve()
      }
      throw new Error('retry requested')
    }
    if (prompt === 'parallel-user-retry-agent') {
      return {
        data: {
          status: 'completed',
          content: [{ type: 'text', text: 'parallel-user-retry-ok' }],
          totalTokens: 20,
          totalToolUseCount: 2,
          totalDurationMs: 5,
        },
      }
    }
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'parallel-other-ok' }],
        totalTokens: 30,
        totalToolUseCount: 3,
        totalDurationMs: 7,
      },
    }
  },
}
const parallelUserRetryWorkflowRunId = `wf_script_parallel_user_retry_usage_${process.pid}`
const parallelUserRetryResult = await runWorkflowScript({
  script: parallelUserRetryScript,
  plan: {
    ...retryPlan,
    name: 'runtime-parallel-user-retry-usage-workflow',
    description: 'Workflow preserving parallel user retry attempt usage.',
    defaults: { ...retryPlan.defaults, maxConcurrency: 2 },
    phases: [{ ...retryPlan.phases[0]!, id: 'Retry', description: 'Parallel user retry usage agents', prompt: 'Parallel user retry usage agents', fanout: 2, concurrency: 2 }],
    totalAgents: 2,
    runScriptSnapshot: parallelUserRetryScript,
  },
  context: {
    ...retryContext,
    getAppState: () => parallelUserRetryState,
    setAppState: setParallelUserRetryState,
    options: { ...retryContext.options, tools: [parallelUserRetryAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_parallel_user_retry_usage',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_parallel_user_retry_usage' } } as never,
  workflowRunId: parallelUserRetryWorkflowRunId,
  scriptPath: '/tmp/runtime-parallel-user-retry-usage-workflow.js',
})
assert.deepEqual(Object.fromEntries(parallelUserRetryCallCounts), {
  'parallel-user-retry-agent': 2,
  'parallel-other-agent': 2,
})
const parallelUserRetryTask = Object.values(parallelUserRetryState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.ok(parallelUserRetryTask)
const parallelUserRetryCompletedStateResult = parallelUserRetryTask.results.find(
  current => current.agentId === 'parallel-user-retry-agent (retry 1)',
)
assert.deepEqual({
  tokenCount: parallelUserRetryCompletedStateResult?.tokenCount,
  toolUseCount: parallelUserRetryCompletedStateResult?.toolUseCount,
  durationMs: parallelUserRetryCompletedStateResult?.durationMs,
}, {
  tokenCount: 20,
  toolUseCount: 2,
  durationMs: 5,
})
const parallelUserRetryTranscriptDir = parallelUserRetryResult.match(/Transcript dir: (.+)/)?.[1]
assert.ok(parallelUserRetryTranscriptDir)
const parallelUserRetryJournalRaw = await readFile(join(parallelUserRetryTranscriptDir, 'journal.jsonl'), 'utf8')
const parallelUserRetryJournalEntries = parallelUserRetryJournalRaw
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as Record<string, unknown>)
const parallelUserRetryAttempt0Id = 'Retry:parallel-user-retry-agent:attempt:0'
const parallelUserRetryAttempt1Id = 'Retry:parallel-user-retry-agent:attempt:1'
const parallelOtherRetryAttempt0Id = 'Retry:parallel-other-agent:attempt:0'
const parallelUserRetryInterruptedEntry = parallelUserRetryJournalEntries.find(
  entry =>
    entry.type === 'result' &&
    entry.attemptId === parallelUserRetryAttempt0Id &&
    entry.status === 'interrupted',
)
const parallelOtherRetryInterruptedEntry = parallelUserRetryJournalEntries.find(
  entry =>
    entry.type === 'result' &&
    entry.attemptId === parallelOtherRetryAttempt0Id &&
    entry.status === 'interrupted',
)
const parallelUserRetryCompletedEntry = parallelUserRetryJournalEntries.find(
  entry =>
    entry.type === 'result' &&
    entry.attemptId === parallelUserRetryAttempt1Id &&
    entry.status === 'completed',
)
assert.deepEqual({
  interruptedStatus: parallelUserRetryInterruptedEntry?.status,
  interruptedTokens: parallelUserRetryInterruptedEntry?.tokenCount,
  interruptedToolUses: parallelUserRetryInterruptedEntry?.toolUseCount,
  otherInterruptedStatus: parallelOtherRetryInterruptedEntry?.status,
  otherInterruptedTokens: parallelOtherRetryInterruptedEntry?.tokenCount,
  otherInterruptedToolUses: parallelOtherRetryInterruptedEntry?.toolUseCount,
  completedStatus: parallelUserRetryCompletedEntry?.status,
  completedTokens: parallelUserRetryCompletedEntry?.tokenCount,
  completedToolUses: parallelUserRetryCompletedEntry?.toolUseCount,
  completedDurationMs: parallelUserRetryCompletedEntry?.durationMs,
}, {
  interruptedStatus: 'interrupted',
  interruptedTokens: 11,
  interruptedToolUses: 1,
  otherInterruptedStatus: 'interrupted',
  otherInterruptedTokens: 104,
  otherInterruptedToolUses: 2,
  completedStatus: 'completed',
  completedTokens: parallelUserRetryCompletedStateResult?.tokenCount,
  completedToolUses: parallelUserRetryCompletedStateResult?.toolUseCount,
  completedDurationMs: parallelUserRetryCompletedStateResult?.durationMs,
})
dequeueAllMatching(command => command.mode === 'task-notification')

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
drainSdkEvents()
dequeueAllMatching(command => command.mode === 'task-notification')

const automaticRetryUsageScript = `export const meta = {
  name: "runtime-automatic-retry-usage-workflow",
  description: "Workflow preserving automatic retry attempt usage.",
  phases: [{ title: "Retry", detail: "Retry usage agent" }],
}
phase("Retry")
const result = await agent("retry-usage-agent", { label: "retry-usage-agent" })
return { result, spent: budget.spent() }
`
let automaticRetryUsageState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
let automaticRetryUsageCallCount = 0
const automaticRetryUsageAgentTool = {
  name: 'Agent',
  async call(
    _input: unknown,
    _agentContext: ToolUseContext,
    _canUseTool: unknown,
    _assistantMessage: unknown,
    onProgress?: (progress: unknown) => void,
  ) {
    automaticRetryUsageCallCount++
    if (automaticRetryUsageCallCount === 1) {
      onProgress?.({
        data: {
          type: 'agent_progress',
          message: {
            type: 'assistant',
            uuid: '00000000-0000-4000-8000-000000000014',
            timestamp: '2026-07-14T00:00:00.000Z',
            message: {
              id: 'msg_automatic_retry_usage_first_progress',
              role: 'assistant',
              model: 'claude-test',
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_automatic_retry_usage_first_1',
                  name: 'Read',
                  input: { file_path: 'first-1.txt' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_automatic_retry_usage_first_2',
                  name: 'Bash',
                  input: { command: 'true' },
                },
              ],
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: {
                input_tokens: 30,
                output_tokens: 7,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
              },
            },
          },
        },
      })
      throw new Error('429 too many requests')
    }
    onProgress?.({
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000015',
          timestamp: '2026-07-14T00:00:00.000Z',
          message: {
            id: 'msg_automatic_retry_usage_second_progress',
            role: 'assistant',
            model: 'claude-test',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_automatic_retry_usage_second_1',
                name: 'Read',
                input: { file_path: 'second-1.txt' },
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
              input_tokens: 20,
              output_tokens: 4,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
        },
      },
    })
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'automatic-retry-usage-ok' }],
        totalDurationMs: 1,
      },
    }
  },
}
const automaticRetryUsageResult = await runWorkflowScript({
  script: automaticRetryUsageScript,
  plan: {
    ...retryPlan,
    name: 'runtime-automatic-retry-usage-workflow',
    description: 'Workflow preserving automatic retry attempt usage.',
    defaults: { ...retryPlan.defaults, maxRetries: 1 },
    phases: [{ ...retryPlan.phases[0]!, id: 'Retry', description: 'Retry usage agent', prompt: 'Retry usage agent' }],
    runScriptSnapshot: automaticRetryUsageScript,
  },
  context: {
    ...retryContext,
    getAppState: () => automaticRetryUsageState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      automaticRetryUsageState = updater(automaticRetryUsageState)
    },
    options: { ...retryContext.options, tools: [automaticRetryUsageAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_automatic_retry_usage',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_automatic_retry_usage' } } as never,
  workflowRunId: `wf_script_automatic_retry_usage_${process.pid}`,
  scriptPath: '/tmp/runtime-automatic-retry-usage-workflow.js',
})
assert.equal(automaticRetryUsageCallCount, 2)
const automaticRetryUsageTask = Object.values(automaticRetryUsageState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.deepEqual({
  tokenCount: automaticRetryUsageTask?.tokenCount,
  toolUseCount: automaticRetryUsageTask?.toolUseCount,
}, {
  tokenCount: 61,
  toolUseCount: 3,
})
const automaticRetryUsageEvents = drainSdkEvents()
const automaticRetryUsageSdkTermination = automaticRetryUsageEvents.find(
  event =>
    event.subtype === 'task_notification' &&
    event.task_id === automaticRetryUsageTask?.id,
)
assert.equal(automaticRetryUsageSdkTermination?.subtype, 'task_notification')
assert.ok(automaticRetryUsageSdkTermination.output_file)
const automaticRetryUsageTranscriptDir = automaticRetryUsageResult.match(/Transcript dir: (.+)/)?.[1]
assert.ok(automaticRetryUsageTranscriptDir)
const automaticRetryUsageOutput = await readFile(
  automaticRetryUsageSdkTermination.output_file,
  'utf8',
)
const automaticRetryUsageJournalEntries = (
  await readFile(join(automaticRetryUsageTranscriptDir, 'journal.jsonl'), 'utf8')
)
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as Record<string, unknown>)
const automaticRetryUsageFailedJournalEntry = automaticRetryUsageJournalEntries.find(
  entry => entry.type === 'result' && entry.status === 'failed',
)
assert.deepEqual({
  sdkTokens: automaticRetryUsageSdkTermination?.usage?.total_tokens,
  sdkToolUses: automaticRetryUsageSdkTermination?.usage?.tool_uses,
  scriptSpent: Number(automaticRetryUsageOutput.match(/"spent":\s*(\d+)/)?.[1]),
  failedJournalDurationType: typeof automaticRetryUsageFailedJournalEntry?.durationMs,
}, {
  sdkTokens: 61,
  sdkToolUses: 3,
  scriptSpent: 61,
  failedJournalDurationType: 'number',
})
dequeueAllMatching(command => command.mode === 'task-notification')

const partialRetryScript = `export const meta = {
  name: "runtime-partial-retry-workflow",
  description: "Retry only the transiently failing parallel worker.",
  phases: [{ title: "Parallel", detail: "One stable and one transient worker" }],
}
phase("Parallel")
return await parallel([
  () => agent("stable-worker", { label: "stable-worker" }),
  () => agent("transient-worker", { label: "transient-worker" }),
])
`
let partialRetryState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const partialRetryCalls = new Map<string, number>()
const partialRetryAgentTool = {
  name: 'Agent',
  async call(input: { prompt?: string }) {
    const prompt = input.prompt ?? ''
    const calls = (partialRetryCalls.get(prompt) ?? 0) + 1
    partialRetryCalls.set(prompt, calls)
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: `${prompt}-ok` }],
        totalDurationMs: 1,
      },
    }
  },
}
const previousWorkflowFaultInjection =
  process.env.CLAUDE_CODE_WORKFLOW_FAULT_INJECTION_FOR_TESTING
process.env.CLAUDE_CODE_WORKFLOW_FAULT_INJECTION_FOR_TESTING =
  'service_unavailable:transient-worker:attempt:0'
try {
  await runWorkflowScript({
    script: partialRetryScript,
    plan: {
      ...retryPlan,
      name: 'runtime-partial-retry-workflow',
      description: 'Retry only the transiently failing parallel worker.',
      defaults: { ...retryPlan.defaults, maxConcurrency: 2, maxRetries: 2 },
      phases: [{
        ...retryPlan.phases[0]!,
        id: 'Parallel',
        description: 'One stable and one transient worker',
        fanout: 2,
        concurrency: 2,
      }],
      totalAgents: 2,
      runScriptSnapshot: partialRetryScript,
    },
    context: {
      ...retryContext,
      getAppState: () => partialRetryState,
      setAppState: (updater: (prev: AppState) => AppState): void => {
        partialRetryState = updater(partialRetryState)
      },
      options: { ...retryContext.options, tools: [partialRetryAgentTool] },
      abortController: new AbortController(),
      toolUseId: 'toolu_script_partial_retry',
    } as unknown as ToolUseContext,
    canUseTool: async () => ({ behavior: 'allow' }),
    assistantMessage: { message: { id: 'msg_script_partial_retry' } } as never,
    workflowRunId: `wf_script_partial_retry_${process.pid}`,
    scriptPath: '/tmp/runtime-partial-retry-workflow.js',
  })
} finally {
  if (previousWorkflowFaultInjection === undefined) {
    delete process.env.CLAUDE_CODE_WORKFLOW_FAULT_INJECTION_FOR_TESTING
  } else {
    process.env.CLAUDE_CODE_WORKFLOW_FAULT_INJECTION_FOR_TESTING =
      previousWorkflowFaultInjection
  }
}
assert.equal(partialRetryCalls.get('stable-worker'), 1)
assert.equal(partialRetryCalls.get('transient-worker'), 1)
const partialRetryTask = Object.values(partialRetryState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(partialRetryTask?.startedAgentAttempts, 3)
assert.equal(partialRetryTask?.retryCount, 1)
assert.deepEqual(
  partialRetryTask?.agentAttempts.map(attempt => ({
    logicalAgentId: attempt.logicalAgentId,
    attempt: attempt.attempt,
    status: attempt.status,
    errorKind: attempt.errorKind,
  })).sort((left, right) => left.logicalAgentId.localeCompare(right.logicalAgentId) || left.attempt - right.attempt),
  [
    { logicalAgentId: 'stable-worker', attempt: 0, status: 'completed', errorKind: undefined },
    { logicalAgentId: 'transient-worker', attempt: 0, status: 'failed', errorKind: 'service_unavailable' },
    { logicalAgentId: 'transient-worker', attempt: 1, status: 'completed', errorKind: undefined },
  ],
)
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

drainSdkEvents()
dequeueAllMatching(command => command.mode === 'task-notification')
let missingSchemaUsageState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const missingSchemaUsageAgentTool = {
  name: 'Agent',
  async call(
    _input: unknown,
    _agentContext: ToolUseContext,
    _canUseTool: unknown,
    _assistantMessage: unknown,
    onProgress?: (progress: unknown) => void,
  ) {
    onProgress?.({
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000016',
          timestamp: '2026-07-14T00:00:00.000Z',
          message: {
            id: 'msg_missing_schema_usage_progress',
            role: 'assistant',
            model: 'claude-test',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_missing_schema_usage_1',
                name: 'Read',
                input: { file_path: 'schema-usage-1.txt' },
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
              input_tokens: 3,
              output_tokens: 4,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
        },
      },
    })
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: '{"ok":true}' }],
        totalTokens: 42,
        totalToolUseCount: 2,
        totalDurationMs: 1,
      },
    }
  },
}
const missingSchemaUsageScript = `export const meta = {
  name: "runtime-missing-schema-usage-workflow",
  description: "Workflow preserving missing schema usage.",
  phases: [{ title: "Schema", detail: "Missing schema usage agent" }],
}
phase("Schema")
const result = await agent("return schema usage", {
  label: "missing-schema-usage-agent",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  },
})
return { result, spent: budget.spent() }
`
const missingSchemaUsageResult = await runWorkflowScript({
  script: missingSchemaUsageScript,
  plan: {
    ...retryPlan,
    name: 'runtime-missing-schema-usage-workflow',
    description: 'Workflow preserving missing schema usage.',
    phases: [{ ...retryPlan.phases[0]!, id: 'Schema', description: 'Missing schema usage agent', prompt: 'Missing schema usage agent' }],
    runScriptSnapshot: missingSchemaUsageScript,
  },
  context: {
    ...retryContext,
    getAppState: () => missingSchemaUsageState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      missingSchemaUsageState = updater(missingSchemaUsageState)
    },
    options: { ...retryContext.options, tools: [missingSchemaUsageAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_missing_schema_usage',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_missing_schema_usage' } } as never,
  workflowRunId: `wf_script_missing_schema_usage_${process.pid}`,
  scriptPath: '/tmp/runtime-missing-schema-usage-workflow.js',
})
const missingSchemaUsageTask = Object.values(missingSchemaUsageState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(missingSchemaUsageTask?.status, 'completed')
assert.equal(missingSchemaUsageTask?.phases[0]?.failedAgentIds.length, 1)
assert.deepEqual({
  tokenCount: missingSchemaUsageTask?.tokenCount,
  toolUseCount: missingSchemaUsageTask?.toolUseCount,
}, {
  tokenCount: 42,
  toolUseCount: 2,
})
const missingSchemaUsageEvents = drainSdkEvents()
const missingSchemaUsageSdkTermination = missingSchemaUsageEvents.find(
  event =>
    event.subtype === 'task_notification' &&
    event.task_id === missingSchemaUsageTask?.id,
)
assert.equal(missingSchemaUsageSdkTermination?.subtype, 'task_notification')
assert.ok(missingSchemaUsageSdkTermination.output_file)
assert.equal(missingSchemaUsageResult.includes('runtime-missing-schema-usage-workflow'), true)
const missingSchemaUsageOutput = await readFile(
  missingSchemaUsageSdkTermination.output_file,
  'utf8',
)
assert.deepEqual({
  sdkTokens: missingSchemaUsageSdkTermination?.usage?.total_tokens,
  sdkToolUses: missingSchemaUsageSdkTermination?.usage?.tool_uses,
  scriptSpent: Number(missingSchemaUsageOutput.match(/"spent":\s*(\d+)/)?.[1]),
}, {
  sdkTokens: 42,
  sdkToolUses: 2,
  scriptSpent: 42,
})

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

drainSdkEvents()
dequeueAllMatching(command => command.mode === 'task-notification')
const skipScript = `export const meta = {
  name: "runtime-skip-agent-workflow",
  description: "Workflow skipping a script agent.",
  phases: [{ title: "Skip", detail: "Skip agent" }],
}
phase("Skip")
const skipped = await agent("skip me", { label: "skipped-agent" })
return { skipped, spent: budget.spent() }
`
let skipState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setSkipState = (updater: (prev: AppState) => AppState): void => {
  skipState = updater(skipState)
}
let skipCallCount = 0
let skipAbortReason: unknown
const skipAgentTool = {
  name: 'Agent',
  async call(
    _input: unknown,
    agentContext: ToolUseContext,
    _canUseTool: unknown,
    _assistantMessage: unknown,
    onProgress?: (progress: unknown) => void,
  ) {
    skipCallCount++
    onProgress?.({
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          uuid: '00000000-0000-4000-8000-000000000018',
          timestamp: '2026-07-14T00:00:00.000Z',
          message: {
            id: 'msg_skip_usage_progress',
            role: 'assistant',
            model: 'claude-test',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_skip_usage_1',
                name: 'Read',
                input: { file_path: 'skip-usage-1.txt' },
              },
              {
                type: 'tool_use',
                id: 'toolu_skip_usage_2',
                name: 'Bash',
                input: { command: 'true' },
              },
            ],
            stop_reason: 'tool_use',
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
            },
          },
        },
      },
    })
    const task = Object.values(skipState.tasks).find(
      (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
    )
    assert.ok(task?.currentAgentId)
    skipWorkflowAgent(task.id, task.currentAgentId, setSkipState)
    skipAbortReason = agentContext.abortController.signal.reason
    throw new Error('skip requested')
  },
}
const skipWorkflowRunId = `wf_script_skip_${process.pid}`
const skipResult = await runWorkflowScript({
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
  workflowRunId: skipWorkflowRunId,
  scriptPath: '/tmp/runtime-skip-agent-workflow.js',
})
const skipNotification = dequeue(command => command.mode === 'task-notification')
assert.ok(skipNotification)
assert.match(String(skipNotification.value), /<status>completed<\/status>/)
assert.equal(skipCallCount, 1)
const skipTask = Object.values(skipState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.ok(skipTask)
const skipSdkEvents = drainSdkEvents()
const skipSdkTermination = skipSdkEvents.find(
  event =>
    event.subtype === 'task_notification' &&
    event.task_id === skipTask.id,
)
assert.equal(skipSdkTermination?.subtype, 'task_notification')
assert.ok(skipSdkTermination.output_file)
const skipOutput = await readFile(skipSdkTermination.output_file, 'utf8')
const skipSession = await loadWorkflowRunSession({
  cwd: scriptCwd,
  workflowRunId: skipWorkflowRunId,
})
const skipTranscriptDir = skipResult.match(/Transcript dir: (.+)/)?.[1]
assert.ok(skipTranscriptDir)
const skipJournalRaw = await readFile(join(skipTranscriptDir, 'journal.jsonl'), 'utf8')
const skipJournalEntries = skipJournalRaw
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as Record<string, unknown>)
const skipJournalResult = skipJournalEntries.find(entry => entry.type === 'result')
assert.deepEqual({
  abortReason: skipAbortReason,
  taskStatus: skipTask.status,
  taskTokens: skipTask.tokenCount,
  taskToolUses: skipTask.toolUseCount,
  taskResultStatus: skipTask.results[0]?.status,
  taskResultTokens: skipTask.results[0]?.tokenCount,
  taskResultToolUses: skipTask.results[0]?.toolUseCount,
  sessionStatus: skipSession?.status,
  sessionTokens: skipSession?.tokenCount,
  sessionToolUses: skipSession?.toolUseCount,
  sessionResultStatus: skipSession?.results[0]?.status,
  sessionResultTokens: skipSession?.results[0]?.tokenCount,
  sessionResultToolUses: skipSession?.results[0]?.toolUseCount,
  sdkStatus: skipSdkTermination.status,
  sdkTokens: skipSdkTermination.usage?.total_tokens,
  sdkToolUses: skipSdkTermination.usage?.tool_uses,
  scriptSpent: Number(skipOutput.match(/"spent":\s*(\d+)/)?.[1]),
  journalStatus: skipJournalResult?.status,
  journalTokens: skipJournalResult?.tokenCount,
  journalToolUses: skipJournalResult?.toolUseCount,
  journalDurationType: typeof skipJournalResult?.durationMs,
  journalHasFailedResult: skipJournalEntries.some(
    entry => entry.type === 'result' && entry.status === 'failed',
  ),
}, {
  abortReason: 'user-skip',
  taskStatus: 'completed',
  taskTokens: 13,
  taskToolUses: 2,
  taskResultStatus: 'skipped',
  taskResultTokens: 13,
  taskResultToolUses: 2,
  sessionStatus: 'completed',
  sessionTokens: 13,
  sessionToolUses: 2,
  sessionResultStatus: 'skipped',
  sessionResultTokens: 13,
  sessionResultToolUses: 2,
  sdkStatus: 'completed',
  sdkTokens: 13,
  sdkToolUses: 2,
  scriptSpent: 13,
  journalStatus: 'skipped',
  journalTokens: 13,
  journalToolUses: 2,
  journalDurationType: 'number',
  journalHasFailedResult: false,
})

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

const promptTooLongScript = `export const meta = {
  name: "runtime-prompt-too-long-workflow",
  description: "Workflow preserving prompt-too-long failure metrics.",
  phases: [{ title: "Fail", detail: "Prompt too long agent" }],
}
phase("Fail")
return await parallel([
  () => agent("prompt-too-long-agent", { label: "prompt-too-long-agent" }),
])
`
const promptTooLongWorkflowRunId = `wf_prompt_too_long_${process.pid}`
const promptTooLongCallCountBefore = agentToolCallCount
const promptTooLongResult = await runWorkflowScript({
  script: promptTooLongScript,
  plan: {
    ...failedPlan,
    name: 'runtime-prompt-too-long-workflow',
    description: 'Workflow preserving prompt-too-long failure metrics.',
    phases: [
      {
        ...failedPlan.phases[0]!,
        fanout: 1,
        concurrency: 1,
      },
    ],
    totalAgents: 1,
    runScriptSnapshot: promptTooLongScript,
  },
  args: { case: 'unit' },
  context,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_prompt_too_long_test' } } as never,
  workflowRunId: promptTooLongWorkflowRunId,
  scriptPath: '/tmp/runtime-prompt-too-long-workflow.js',
})
assert.equal(agentToolCallCount, promptTooLongCallCountBefore + 1)
const promptTooLongTask = Object.values(state.tasks).find(
  (task): task is LocalWorkflowTaskState =>
    task.type === 'local_workflow' && task.workflowRunId === promptTooLongWorkflowRunId,
)
assert.ok(promptTooLongTask)
assert.equal(promptTooLongTask.retryCount, 0)
assert.equal(promptTooLongTask.tokenCount, 173_379)
assert.equal(promptTooLongTask.toolUseCount, 12)
assert.deepEqual(promptTooLongTask.results.map(result => ({
  status: result.status,
  error: result.error,
  errorKind: result.errorKind,
  prompt: result.prompt,
  tokenCount: result.tokenCount,
  toolUseCount: result.toolUseCount,
  durationMs: result.durationMs,
})), [
  {
    status: 'failed',
    error: 'Prompt is too long',
    errorKind: 'prompt_too_long',
    prompt: 'prompt-too-long-agent',
    tokenCount: 173_379,
    toolUseCount: 12,
    durationMs: undefined,
  },
])
const promptTooLongTranscriptDirMatch = promptTooLongResult.match(/Transcript dir: (.+)/)
assert.ok(promptTooLongTranscriptDirMatch?.[1])
const promptTooLongJournalRaw = await readFile(
  join(promptTooLongTranscriptDirMatch[1], 'journal.jsonl'),
  'utf8',
)
assert.match(promptTooLongJournalRaw, /"errorKind":"prompt_too_long"/)
assert.match(promptTooLongJournalRaw, /"tokenCount":173379/)
assert.match(promptTooLongJournalRaw, /"toolUseCount":12/)
assert.match(promptTooLongJournalRaw, /"durationMs":\d+/)
assert.doesNotMatch(promptTooLongJournalRaw, /"retryOfAttemptId"/)
const promptTooLongSession = await loadWorkflowRunSession({
  cwd: scriptCwd,
  workflowRunId: promptTooLongWorkflowRunId,
})
assert.equal(promptTooLongSession?.results.length, 1)
assert.deepEqual(promptTooLongSession?.results[0], promptTooLongTask.results[0])
assert.equal(promptTooLongSession?.results[0]?.prompt, 'prompt-too-long-agent')
assert.equal(
  classifyWorkflowAgentError(new Error('Prompt is too long')),
  'prompt_too_long',
)

drainSdkEvents()
dequeueAllMatching(command => command.mode === 'task-notification')
const stalledParallelScript = `export const meta = {
  name: "runtime-stalled-parallel-workflow",
  description: "Workflow settling after a parallel agent ignores abort.",
  phases: [{ title: "Parallel", detail: "One completed and one stalled agent" }],
}
phase("Parallel")
return await parallel([
  () => agent("complete-agent", { label: "complete-agent", stallMs: 20 }),
  () => agent("stalled-agent", { label: "stalled-agent", stallMs: 20 }),
])
`
let stalledParallelState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
let releaseStalledAgent: (() => void) | undefined
const stalledParallelAgentTool = {
  name: 'Agent',
  async call(input: { prompt?: string }) {
    if (input.prompt === 'stalled-agent') {
      return await new Promise(resolve => {
        releaseStalledAgent = () => resolve({
          data: {
            status: 'completed',
            content: [{ type: 'text', text: 'released-after-timeout' }],
          },
        })
      })
    }
    return {
      data: {
        status: 'completed',
        content: [{ type: 'text', text: 'complete-ok' }],
        totalDurationMs: 1,
      },
    }
  },
}
const stalledParallelRun = runWorkflowScript({
  script: stalledParallelScript,
  plan: {
    ...failedPlan,
    name: 'runtime-stalled-parallel-workflow',
    description: 'Workflow settling after a parallel agent ignores abort.',
    phases: [{
      ...failedPlan.phases[0]!,
      id: 'Parallel',
      description: 'One completed and one stalled agent',
    }],
    runScriptSnapshot: stalledParallelScript,
  },
  context: {
    ...context,
    getAppState: () => stalledParallelState,
    setAppState: (updater: (prev: AppState) => AppState): void => {
      stalledParallelState = updater(stalledParallelState)
    },
    options: { ...context.options, tools: [stalledParallelAgentTool] },
    abortController: new AbortController(),
    toolUseId: 'toolu_script_stalled_parallel',
  } as unknown as ToolUseContext,
  canUseTool: async () => ({ behavior: 'allow' }),
  assistantMessage: { message: { id: 'msg_script_stalled_parallel' } } as never,
  workflowRunId: `wf_script_stalled_parallel_${process.pid}`,
  scriptPath: '/tmp/runtime-stalled-parallel-workflow.js',
})
const stalledParallelCompleted = stalledParallelRun.then(() => true)
const stalledParallelSettledAfterAbort = await Promise.race([
  stalledParallelCompleted,
  new Promise<false>(resolve => setTimeout(() => resolve(false), 250)),
])
if (!stalledParallelSettledAfterAbort) releaseStalledAgent?.()
await stalledParallelCompleted
assert.equal(stalledParallelSettledAfterAbort, true)
const stalledParallelTask = Object.values(stalledParallelState.tasks).find(
  (item): item is LocalWorkflowTaskState => item.type === 'local_workflow',
)
assert.equal(stalledParallelTask?.status, 'completed')
assert.deepEqual(
  stalledParallelTask?.results
    .map(result => ({ agentId: result.agentId, status: result.status }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId)),
  [
    { agentId: 'complete-agent', status: 'completed' },
    { agentId: 'stalled-agent', status: 'failed' },
  ],
)
const stalledParallelNotification = dequeue(
  command =>
    command.mode === 'task-notification' &&
    String(command.value).includes(stalledParallelTask?.id ?? ''),
)
assert.ok(stalledParallelNotification)
assert.match(String(stalledParallelNotification.value), /<status>completed<\/status>/)

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
