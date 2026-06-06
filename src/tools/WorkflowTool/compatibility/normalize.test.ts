import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeWorkflowExecutorResult } from './normalize.js'
import type { WorkflowExecutorResult } from './types.js'

const artifacts = {
  caseId: 'RUN-001',
  executor: 'official' as const,
  attempt: 1,
  workspacePath: '/tmp/run',
  command: ['claude'],
  env: {},
  stdoutPath: 'stdout.txt',
  stderrPath: 'stderr.txt',
  filesManifestPath: 'files.json',
  metadataPath: 'metadata.json',
}

describe('workflow compatibility normalization', () => {
  it('extracts stable workflow mechanics from stdout and metadata', () => {
    const result: WorkflowExecutorResult = {
      artifacts,
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdout: 'workflowRunId: wf_123\nscriptPath: /tmp/script.js\nworkflow_progress\nworkflow_agent\nGenerated prose here.\n',
      stderr: '',
      timedOut: false,
    }

    const normalized = normalizeWorkflowExecutorResult(result, {
      files: ['.claude/workflow-runs/wf_123/session.json\t100'],
      metadata: { custom: true },
    })

    assert.equal(normalized.hasWorkflowRunId, true)
    assert.equal(normalized.hasScriptPath, true)
    assert.deepEqual(normalized.eventTypes, ['workflow_agent', 'workflow_progress'])
    assert.equal(normalized.stdoutBucket, 'workflow-mechanics-and-prose')
    assert.deepEqual(normalized.filePaths, ['.claude/workflow-runs/wf_123/session.json'])
  })

  it('recognizes local display labels for workflow identity fields', () => {
    const result: WorkflowExecutorResult = {
      artifacts,
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdout: 'Workflow run ID: wf_local\nScript path: /tmp/local-workflow.js\n',
      stderr: '',
      timedOut: false,
    }

    const normalized = normalizeWorkflowExecutorResult(result, {
      files: [],
      metadata: {},
    })

    assert.equal(normalized.hasWorkflowRunId, true)
    assert.equal(normalized.hasScriptPath, true)
  })

  it('detects unavailable official Workflow tool messages', () => {
    const result: WorkflowExecutorResult = {
      artifacts,
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdout: 'I can’t call `Workflow({"name":"demo"})` because no `Workflow` tool is available in this session’s tool list.\n',
      stderr: '',
      timedOut: false,
    }

    const normalized = normalizeWorkflowExecutorResult(result, {
      files: [],
      metadata: {},
    })

    assert.equal(normalized.workflowSurfaceUnavailable, true)
  })
})
