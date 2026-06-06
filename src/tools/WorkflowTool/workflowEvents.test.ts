import assert from 'node:assert/strict'

import {
  createWorkflowAgentEvent,
  createWorkflowLogEvent,
  createWorkflowPhaseEvent,
  createWorkflowProgressEvent,
  WORKFLOW_EVENT_TYPES,
} from './workflowEvents.js'

assert.deepEqual(WORKFLOW_EVENT_TYPES, [
  'workflow_progress',
  'workflow_phase',
  'workflow_agent',
  'workflow_log',
])

assert.deepEqual(
  createWorkflowProgressEvent({
    workflowRunId: 'wf_test',
    status: 'running',
    completedAgents: 1,
    totalAgents: 3,
    timestamp: 10,
  }),
  {
    type: 'workflow_progress',
    workflowRunId: 'wf_test',
    status: 'running',
    completedAgents: 1,
    totalAgents: 3,
    timestamp: 10,
  },
)

assert.deepEqual(
  createWorkflowPhaseEvent({
    workflowRunId: 'wf_test',
    phaseId: 'scan',
    status: 'completed',
    timestamp: 11,
  }),
  {
    type: 'workflow_phase',
    workflowRunId: 'wf_test',
    phaseId: 'scan',
    status: 'completed',
    timestamp: 11,
  },
)

assert.deepEqual(
  createWorkflowAgentEvent({
    workflowRunId: 'wf_test',
    phaseId: 'scan',
    agentId: 'agent-1',
    status: 'completed',
    cacheHit: true,
    timestamp: 12,
  }),
  {
    type: 'workflow_agent',
    workflowRunId: 'wf_test',
    phaseId: 'scan',
    agentId: 'agent-1',
    status: 'completed',
    cacheHit: true,
    timestamp: 12,
  },
)

assert.deepEqual(
  createWorkflowLogEvent({
    workflowRunId: 'wf_test',
    message: 'started',
    timestamp: 13,
  }),
  {
    type: 'workflow_log',
    workflowRunId: 'wf_test',
    message: 'started',
    timestamp: 13,
  },
)

console.log('workflowEvents.test.ts passed')
