#!/usr/bin/env node
import assert from 'node:assert/strict'

import { formatWorkflowStatus } from './formatWorkflowStatus.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask.js'

function workflowState(
  overrides: Partial<LocalWorkflowTaskState> = {},
): LocalWorkflowTaskState {
  return {
    type: 'local_workflow',
    id: 'wf_123',
    status: 'pending',
    description: 'Workflow: code-audit',
    summary: 'Paused by user',
    startTime: 1,
    workflowName: 'code-audit',
    workflowRunId: 'run_123',
    scriptPath: '/tmp/workflow.js',
    runArgs: '',
    phases: [],
    results: [],
    events: [],
    liveAgents: {},
    tokenCount: 0,
    toolUseCount: 0,
    ...overrides,
  } as LocalWorkflowTaskState
}

const state = workflowState({
  liveAgents: {
    agent_live: {
      tokenCount: 1,
      toolUseCount: 0,
      activity: 'aborting',
    },
  },
  results: [
    {
      phaseId: 'phase-1',
      agentId: 'agent_done',
      index: 0,
      status: 'completed',
      output: 'ok',
    },
    {
      phaseId: 'phase-1',
      agentId: 'agent_failed',
      index: 1,
      status: 'failed',
      error: 'Concurrency limit exceeded for user',
      errorKind: 'concurrency_limit',
    },
    {
      phaseId: 'phase-1',
      agentId: 'agent_skipped',
      index: 2,
      status: 'skipped',
    },
  ],
})

const text = formatWorkflowStatus(state)

assert.match(text, /Child agents:/)
assert.match(text, /1 completed/)
assert.match(text, /1 failed/)
assert.match(text, /1 skipped/)
assert.match(text, /1 live\/aborting/)
assert.match(text, /1 blocked by concurrency limit/)

const retriedText = formatWorkflowStatus(workflowState({
  retryCount: 2,
  phases: [
    {
      id: 'phase-1',
      status: 'completed',
      agentIds: ['agent_done'],
      completedAgentIds: ['agent_done'],
      failedAgentIds: [],
      skippedAgentIds: [],
      results: [
        {
          phaseId: 'phase-1',
          agentId: 'agent_done',
          index: 0,
          status: 'completed',
        },
      ],
    },
  ],
}))
assert.match(retriedText, /Retries: 2/)
assert.doesNotMatch(retriedText, /phase-1:.*retries:/)

const failedTerminalText = formatWorkflowStatus(workflowState({
  status: 'completed',
  agentCount: 2,
  phases: [
    {
      id: 'phase-1',
      status: 'failed',
      agentIds: ['agent_done', 'agent_failed'],
      completedAgentIds: ['agent_done'],
      failedAgentIds: ['agent_failed'],
      skippedAgentIds: [],
      results: [],
    },
  ],
}))
assert.match(failedTerminalText, /Agents: 2\/2/)
assert.match(failedTerminalText, /Progress: \[██████████\] 2\/2 \(100%\)/)
assert.match(failedTerminalText, /phase-1: failed 2\/2 \[██████████\]/)

const bundledResumeText = formatWorkflowStatus(workflowState({
  workflowName: 'code-review',
  workflowRunId: 'wf_fcc6c814-236',
  scriptPath: 'bundled:code-review',
}), { detail: true })
assert.match(
  bundledResumeText,
  /Workflow\(\{name: "code-review", resumeFromRunId: "wf_fcc6c814-236"\}\)/,
)
assert.doesNotMatch(bundledResumeText, /scriptPath: "bundled:code-review"/)

const namedPlanResumeText = formatWorkflowStatus(workflowState({
  workflowName: 'deep-research',
  workflowRunId: 'wf_225081eb-6e0',
  scriptPath: undefined,
  runArgs: 'Research workflow resume prompt behavior in one concise pass.',
}), { detail: true })
assert.match(
  namedPlanResumeText,
  /Workflow\(\{name: "deep-research", args: "Research workflow resume prompt behavior in one concise pass\.", resumeFromRunId: "wf_225081eb-6e0"\}\)/,
)
assert.doesNotMatch(namedPlanResumeText, /Resume unavailable/)

console.log('formatWorkflowStatus.test.ts passed')
