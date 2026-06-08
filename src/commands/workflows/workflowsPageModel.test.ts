#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  formatWorkflowEmptyState,
  formatWorkflowListRow,
  getWorkflowPageItems,
} from './workflowsPageModel.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

function workflowTask(
  overrides: Partial<LocalWorkflowTaskState>,
): LocalWorkflowTaskState {
  return {
    id: 'w-default',
    type: 'local_workflow',
    status: 'running',
    description: 'Workflow: Default',
    startTime: 1000,
    outputFile: '.claude/tasks/w-default.output',
    outputOffset: 0,
    notified: false,
    workflowName: 'Default',
    agentCount: 3,
    tokenCount: 0,
    toolUseCount: 0,
    phases: [
      {
        id: 'scan',
        status: 'running',
        agentIds: ['a1', 'a2', 'a3'],
        completedAgentIds: ['a1'],
        skippedAgentIds: [],
        failedAgentIds: [],
        results: [],
      },
    ],
    results: [],
    events: [],
    ...overrides,
  }
}

assert.equal(formatWorkflowEmptyState(), 'No dynamic workflows in this session.')

const running = workflowTask({
  id: 'w-running',
  workflowName: 'Deep Research',
  status: 'running',
  startTime: 2_000,
  agentCount: 4,
  tokenCount: 1234,
  toolUseCount: 5,
  phases: [
    {
      id: 'scope',
      status: 'completed',
      agentIds: ['a1'],
      completedAgentIds: ['a1'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
    {
      id: 'research',
      status: 'running',
      agentIds: ['a2', 'a3', 'a4'],
      completedAgentIds: ['a2'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
  ],
})
const completed = workflowTask({
  id: 'w-completed',
  workflowName: 'Code Review',
  status: 'completed',
  startTime: 3_000,
  endTime: 7_000,
  agentCount: 2,
  tokenCount: 90,
  toolUseCount: 1,
  phases: [
    {
      id: 'review',
      status: 'completed',
      agentIds: ['b1', 'b2'],
      completedAgentIds: ['b1', 'b2'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
  ],
})
const failed = workflowTask({
  id: 'w-failed',
  workflowName: undefined,
  description: 'Workflow: Bugfix',
  status: 'failed',
  startTime: 1_000,
  endTime: 2_000,
  error: 'agent failed',
  agentCount: 2,
  phases: [
    {
      id: 'reproduce',
      status: 'failed',
      agentIds: ['c1', 'c2'],
      completedAgentIds: ['c1'],
      skippedAgentIds: [],
      failedAgentIds: ['c2'],
      results: [],
    },
  ],
})

const items = getWorkflowPageItems({
  other: { ...running, id: 'other', type: 'local_bash' as never },
  [completed.id]: completed,
  [failed.id]: failed,
  [running.id]: running,
})

assert.deepEqual(
  items.map(item => item.id),
  ['w-running', 'w-completed', 'w-failed'],
)
assert.deepEqual(items[0], {
  id: 'w-running',
  title: 'Deep Research',
  status: 'running',
  completedAgents: 2,
  totalAgents: 4,
  progressLabel: '2/4 agents',
  metricsLabel: '1,234 tokens · 5 tool uses',
})
assert.equal(
  formatWorkflowListRow(items[0]!, true),
  '› Deep Research — running — 2/4 agents — 1,234 tokens · 5 tool uses',
)
assert.equal(
  formatWorkflowListRow(items[1]!, false),
  '  Code Review — completed — 2/2 agents — 90 tokens · 1 tool use',
)
assert.equal(
  formatWorkflowListRow(items[2]!, false),
  '  Bugfix — failed — 1/2 agents — 0 tokens · 0 tool uses',
)

const staged = workflowTask({
  id: 'w-staged',
  workflowName: 'Staged Workflow',
  status: 'running',
  agentCount: 4,
  phases: [
    {
      id: 'Fanout',
      status: 'running',
      agentIds: ['fanout-1', 'fanout-2', 'fanout-3'],
      completedAgentIds: [],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
    {
      id: 'After',
      status: 'pending',
      agentIds: [],
      completedAgentIds: [],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
  ],
})
const stagedItem = getWorkflowPageItems({ [staged.id]: staged })[0]!
assert.equal(stagedItem.totalAgents, 3)
assert.equal(stagedItem.progressLabel, '0/3 agents')
assert.equal(
  formatWorkflowListRow(stagedItem, true),
  '› Staged Workflow — running — 0/3 agents — 0 tokens · 0 tool uses',
)

console.log('workflowsPageModel.test.ts passed')
