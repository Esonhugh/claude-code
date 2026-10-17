#!/usr/bin/env node
import assert from 'node:assert/strict'

import {
  formatWorkflowEmptyState,
  getWorkflowPageItems,
} from './workflowsPageModel.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowRunSession } from '../../tools/WorkflowTool/workflowRunSessions.js'

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
    phases: [{
      id: 'scan', status: 'running',
      agentIds: ['a1', 'a2', 'a3'], completedAgentIds: ['a1'],
      skippedAgentIds: [], failedAgentIds: [], results: [],
    }],
    results: [],
    events: [],
    ...overrides,
  }
}

assert.equal(formatWorkflowEmptyState(), 'No dynamic workflows in this session.')

const running = workflowTask({
  id: 'w-running', workflowName: 'Deep Research', status: 'running',
  startTime: 2_000, agentCount: 4, tokenCount: 1234, toolUseCount: 5,
  phases: [
    { id: 'scope', status: 'completed', agentIds: ['a1'], completedAgentIds: ['a1'], skippedAgentIds: [], failedAgentIds: [], results: [] },
    { id: 'research', status: 'running', agentIds: ['a2', 'a3', 'a4'], completedAgentIds: ['a2'], skippedAgentIds: [], failedAgentIds: [], results: [] },
  ],
})
const completed = workflowTask({
  id: 'w-completed', workflowName: 'Code Review', status: 'completed',
  startTime: 3_000, endTime: 7_000, agentCount: 2, tokenCount: 90, toolUseCount: 1,
  phases: [
    { id: 'review', status: 'completed', agentIds: ['b1', 'b2'], completedAgentIds: ['b1', 'b2'], skippedAgentIds: [], failedAgentIds: [], results: [] },
  ],
})
const failed = workflowTask({
  id: 'w-failed', workflowName: undefined, description: 'Workflow: Bugfix', status: 'failed',
  startTime: 1_000, endTime: 2_000, error: 'agent failed', agentCount: 2,
  phases: [
    { id: 'reproduce', status: 'failed', agentIds: ['c1', 'c2'], completedAgentIds: ['c1'], skippedAgentIds: [], failedAgentIds: ['c2'], results: [] },
  ],
})

const items = getWorkflowPageItems({
  other: { ...running, id: 'other', type: 'local_bash' as never },
  [completed.id]: completed,
  [failed.id]: failed,
  [running.id]: running,
})

// Items sorted by startTime descending
assert.deepEqual(items.map(item => item.id), ['w-completed', 'w-running', 'w-failed'])
assert.equal(items[0]!.title, 'Code Review')
assert.equal(items[0]!.icon, '✓')
assert.equal(items[0]!.iconColor, 'success')
assert.equal(items[1]!.title, 'Deep Research')
assert.equal(items[1]!.icon, '↻')
assert.equal(items[2]!.title, 'Bugfix')
assert.equal(items[2]!.icon, '✗')
assert.equal(items[2]!.iconColor, 'error')
assert.equal(items[1]!.completedAgents, 2)
assert.equal(items[1]!.totalAgents, 4)
assert.equal(items[2]!.completedAgents, 2)
assert.equal(items[2]!.totalAgents, 2)

const stagedRunning = getWorkflowPageItems({
  staged: workflowTask({
    id: 'w-staged',
    agentCount: 4,
    phases: [
      { id: 'fanout', status: 'running', agentIds: ['a1', 'a2', 'a3'], completedAgentIds: [], skippedAgentIds: [], failedAgentIds: [], results: [] },
      { id: 'after', status: 'pending', agentIds: [], completedAgentIds: [], skippedAgentIds: [], failedAgentIds: [], results: [] },
    ],
  }),
})
assert.equal(stagedRunning[0]!.totalAgents, 4)
assert.match(stagedRunning[0]!.metricsText, /4 agents/)

function persistedSession(overrides: Partial<WorkflowRunSession>): WorkflowRunSession {
  return {
    taskId: 'w-persisted',
    workflowRunId: 'wf_persisted',
    workflowName: 'Persisted',
    status: 'completed',
    resumeCacheEntries: [],
    startedAt: 500,
    updatedAt: 900,
    results: [
      { phaseId: 'scan', agentId: 'p1', index: 0, status: 'completed', output: 'ok', tokenCount: 7 },
      { phaseId: 'scan', agentId: 'p2', index: 1, status: 'failed', error: 'bad', tokenCount: 3 },
    ],
    events: [],
    agentCount: 2,
    ...overrides,
  }
}

// Persisted runs that are no longer live are listed after live ones,
// deduped against live tasks by workflowRunId.
const withPersisted = getWorkflowPageItems(
  {
    [running.id]: { ...running, workflowRunId: 'wf_live' },
  },
  [
    persistedSession({ taskId: 'w-stale-copy', workflowRunId: 'wf_live', workflowName: 'Stale copy', startedAt: 9_000 }),
    persistedSession({}),
  ],
)
assert.deepEqual(withPersisted.map(item => [item.id, item.source]), [
  ['w-running', 'live'],
  ['w-persisted', 'persisted'],
])
const persistedItem = withPersisted[1]!
assert.equal(persistedItem.title, 'Persisted')
assert.equal(persistedItem.status, 'completed')
assert.equal(persistedItem.icon, '✓')
assert.equal(persistedItem.completedAgents, 2)
assert.equal(persistedItem.totalAgents, 2)
assert.equal(persistedItem.task.workflowRunId, 'wf_persisted')
assert.equal(persistedItem.task.endTime, 900)
assert.match(persistedItem.metricsText, /2 agents · 10 tok/)

console.log('workflowsPageModel.test.ts passed')
