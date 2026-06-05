import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  compareWorkflowCompatibility,
  normalizeWorkflowObservation,
} from './workflowCompatibilityBenchmark.js'

const officialObservation = {
  tool: 'Workflow',
  workflowRunId: 'wf-official-1',
  scriptPath: '/tmp/session/workflows/research.js',
  events: [
    { type: 'workflow_progress', status: 'running' },
    { type: 'workflow_phase', phase: 'research', status: 'completed' },
    { type: 'workflow_agent', phase: 'research', status: 'completed' },
    { type: 'workflow_log', message: 'review complete' },
  ],
  argsKind: 'object',
  supportsScriptPathRerun: true,
  supportsUserWorkflowDiscovery: true,
}

const localObservation = {
  tool: 'WorkflowTool',
  workflowRunId: undefined,
  scriptPath: undefined,
  events: [{ type: 'task_local_workflow', status: 'completed' }],
  argsKind: 'string',
  supportsScriptPathRerun: false,
  supportsUserWorkflowDiscovery: false,
}

describe('workflow compatibility benchmark', () => {
  it('normalizes official and local observations into comparable feature flags', () => {
    assert.deepEqual(normalizeWorkflowObservation(officialObservation), {
      hasWorkflowFacade: true,
      hasWorkflowRunId: true,
      hasScriptPath: true,
      hasOfficialProgressEvents: true,
      structuredArgs: true,
      scriptPathRerun: true,
      userWorkflowDiscovery: true,
    })
  })

  it('scores missing local compatibility gaps against official behavior', () => {
    const report = compareWorkflowCompatibility({
      official: officialObservation,
      local: localObservation,
    })

    assert.equal(report.score, 0)
    assert.deepEqual(report.gaps, [
      'hasWorkflowFacade',
      'hasWorkflowRunId',
      'hasScriptPath',
      'hasOfficialProgressEvents',
      'structuredArgs',
      'scriptPathRerun',
      'userWorkflowDiscovery',
    ])
  })

  it('passes the compatibility threshold when local workflow signals match official signals', () => {
    const report = compareWorkflowCompatibility({
      official: officialObservation,
      local: {
        tool: 'Workflow',
        workflowRunId: 'wf-local-1',
        scriptPath: '/tmp/local/workflow.js',
        events: [
          { type: 'workflow_progress' },
          { type: 'workflow_phase' },
          { type: 'workflow_agent' },
          { type: 'workflow_log' },
        ],
        argsKind: 'object',
        supportsScriptPathRerun: true,
        supportsUserWorkflowDiscovery: true,
      },
    })

    assert.equal(report.score, 100)
    assert.equal(report.gaps.length, 0)
  })
})
