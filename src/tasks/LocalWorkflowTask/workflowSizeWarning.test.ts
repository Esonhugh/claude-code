#!/usr/bin/env node
import assert from 'node:assert/strict'

import type { LocalWorkflowTaskState } from './LocalWorkflowTask.js'
import {
  WORKFLOW_SIZE_WARNING_AGENTS,
  WORKFLOW_SIZE_WARNING_ASSUMED_AGENT_TOKENS,
  WORKFLOW_SIZE_WARNING_SHORT_TEXT,
  WORKFLOW_SIZE_WARNING_TEXT,
  WORKFLOW_SIZE_WARNING_TOKENS,
  workflowSizeWarning,
  workflowTaskSizeWarning,
} from './workflowSizeWarning.js'

const savedAgentsEnv = process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS
const savedTokensEnv = process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS
delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS
delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS

try {
  // Official 2.1.303 constants and strings.
  assert.equal(WORKFLOW_SIZE_WARNING_AGENTS, 25)
  assert.equal(WORKFLOW_SIZE_WARNING_TOKENS, 1_500_000)
  assert.equal(WORKFLOW_SIZE_WARNING_ASSUMED_AGENT_TOKENS, 70_000)
  assert.ok(WORKFLOW_SIZE_WARNING_TEXT.endsWith(' Large workflow · /workflows to stop'))
  assert.ok(WORKFLOW_SIZE_WARNING_SHORT_TEXT.endsWith(' Large workflow'))

  const base = { startedAgents: 0, totalTokens: 0, ultracodeActive: false, guideline: undefined }

  // Under both caps: no warning. Over the agent cap alone: axis agents.
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 21 }), undefined)
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 25, startedAgents: 25, totalTokens: 25_000 }), undefined)
  assert.deepEqual(workflowSizeWarning({ ...base, scheduledAgents: 26, startedAgents: 26, totalTokens: 26_000 }), {
    axis: 'agents',
    scheduledAgents: 26,
    totalTokens: 26_000,
    projectedTokens: 26_000,
    agentCap: 25,
    tokenCap: 1_500_000,
    capFromGuideline: false,
  })

  // Token axis: spent tokens over the cap, or the per-started-agent average projected over the schedule.
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 3, startedAgents: 3, totalTokens: 1_500_001 })?.axis, 'tokens')
  const projected = workflowSizeWarning({ ...base, scheduledAgents: 10, startedAgents: 2, totalTokens: 400_000 })
  assert.equal(projected?.axis, 'tokens')
  assert.equal(projected?.projectedTokens, 2_000_000)
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 10, startedAgents: 2, totalTokens: 200_000 }), undefined)
  // No started agents yet: 70k per scheduled agent.
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 22 })?.projectedTokens, 1_540_000)
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 22 })?.axis, 'tokens')
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 30 })?.axis, 'both')

  // Ultracode suppresses the warning entirely.
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 100, ultracodeActive: true }), undefined)

  // Agent cap precedence: env > /config guideline (small 5, medium 10, large 50) > 25.
  assert.deepEqual(
    workflowSizeWarning({ ...base, scheduledAgents: 6, guideline: 'small' }),
    { axis: 'agents', scheduledAgents: 6, totalTokens: 0, projectedTokens: 420_000, agentCap: 5, tokenCap: 1_500_000, capFromGuideline: true },
  )
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 10, guideline: 'medium' }), undefined)
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 11, guideline: 'medium' })?.agentCap, 10)
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 26, startedAgents: 26, totalTokens: 26_000, guideline: 'large' }), undefined)
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 26, guideline: 'unrestricted' })?.agentCap, 25)
  process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS = '3'
  const envWarning = workflowSizeWarning({ ...base, scheduledAgents: 4, guideline: 'large' })
  assert.equal(envWarning?.agentCap, 3)
  assert.equal(envWarning?.capFromGuideline, false)
  process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS = 'many'
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 26 })?.agentCap, 25)
  process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS = '0'
  assert.equal(workflowSizeWarning({ ...base, scheduledAgents: 26 })?.agentCap, 25)
  delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS
  process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS = '1000'
  assert.deepEqual(
    workflowSizeWarning({ ...base, scheduledAgents: 1, startedAgents: 1, totalTokens: 1001 }),
    { axis: 'tokens', scheduledAgents: 1, totalTokens: 1001, projectedTokens: 1001, agentCap: 25, tokenCap: 1000, capFromGuideline: false },
  )
  delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS

  // Task wrapper: scheduled = agentCount, started = attempts, tokens = tokenCount; only while running.
  const task = {
    type: 'local_workflow',
    id: 'wf_size',
    status: 'running',
    description: 'Workflow: big',
    startTime: 1,
    agentCount: 30,
    startedAgentAttempts: 4,
    tokenCount: 100_000,
    phases: [],
    results: [],
  } as unknown as LocalWorkflowTaskState
  const taskWarning = workflowTaskSizeWarning(task, false)
  assert.equal(taskWarning?.axis, 'agents')
  assert.equal(taskWarning?.projectedTokens, 750_000)
  assert.equal(workflowTaskSizeWarning({ ...task, status: 'completed' }, false), undefined)
  assert.equal(workflowTaskSizeWarning(task, true), undefined)
  assert.equal(
    workflowTaskSizeWarning({ ...task, agentCount: undefined, phases: [{ agentIds: new Array(26).fill('a') }] } as unknown as LocalWorkflowTaskState, false)?.scheduledAgents,
    26,
  )
  assert.equal(workflowTaskSizeWarning({ ...task, agentCount: 5 }, false), undefined)
} finally {
  if (savedAgentsEnv === undefined) delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS
  else process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS = savedAgentsEnv
  if (savedTokensEnv === undefined) delete process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS
  else process.env.CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS = savedTokensEnv
}

console.log('workflowSizeWarning.test.ts passed')
