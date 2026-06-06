import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { compareNormalizedWorkflowResults } from './compare.js'
import type { WorkflowNormalizedResult, WorkflowRunArtifacts } from './types.js'

const officialArtifacts: WorkflowRunArtifacts = {
  caseId: 'RUN-001',
  executor: 'official',
  attempt: 1,
  workspacePath: '/tmp/official',
  command: ['claude'],
  env: {},
  stdoutPath: 'stdout.txt',
  stderrPath: 'stderr.txt',
  filesManifestPath: 'files.json',
  metadataPath: 'metadata.json',
}

const localArtifacts: WorkflowRunArtifacts = {
  ...officialArtifacts,
  executor: 'local',
  workspacePath: '/tmp/local',
}

const comparison = {
  mode: 'schema' as const,
  requiredEventTypes: ['workflow_progress'],
  proseFields: [],
}

function normalized(overrides: Partial<WorkflowNormalizedResult>): WorkflowNormalizedResult {
  return {
    caseId: 'RUN-001',
    executor: 'official',
    exitCode: 0,
    timedOut: false,
    eventTypes: ['workflow_progress'],
    hasWorkflowRunId: true,
    hasScriptPath: true,
    workflowSurfaceUnavailable: false,
    stdoutBucket: 'workflow-mechanics-and-prose',
    stderrBucket: 'empty',
    filePaths: [],
    metadata: {},
    ...overrides,
  }
}

describe('workflow compatibility comparison', () => {
  it('marks matching mechanics as same', () => {
    const diff = compareNormalizedWorkflowResults({
      caseId: 'RUN-001',
      official: normalized({ executor: 'official' }),
      local: normalized({ executor: 'local' }),
      officialArtifacts,
      localArtifacts,
      comparison,
      rerunCount: 0,
    })

    assert.equal(diff.status, 'same')
    assert.equal(diff.confidence, 'single-run')
    assert.deepEqual(diff.differences, [])
  })

  it('marks metadata and file path differences', () => {
    const diff = compareNormalizedWorkflowResults({
      caseId: 'RUN-001',
      official: normalized({
        executor: 'official',
        filePaths: ['.claude/workflow-runs/wf_1/session.json'],
        metadata: { exitCode: 0, timedOut: false },
      }),
      local: normalized({
        executor: 'local',
        filePaths: [],
        metadata: { exitCode: 0, timedOut: true },
      }),
      officialArtifacts,
      localArtifacts,
      comparison,
      rerunCount: 2,
    })

    assert.equal(diff.status, 'different')
    assert.ok(diff.differences.some(difference => difference.includes('file paths')))
    assert.ok(diff.differences.some(difference => difference.includes('metadata')))
  })

  it('ignores volatile duration metadata', () => {
    const diff = compareNormalizedWorkflowResults({
      caseId: 'RUN-001',
      official: normalized({ executor: 'official', metadata: { exitCode: 0, durationMs: 111 } }),
      local: normalized({ executor: 'local', metadata: { exitCode: 0, durationMs: 999 } }),
      officialArtifacts,
      localArtifacts,
      comparison,
      rerunCount: 0,
    })

    assert.equal(diff.status, 'same')
  })

  it('enforces per-case required event types', () => {
    const diff = compareNormalizedWorkflowResults({
      caseId: 'RUN-001',
      official: normalized({ executor: 'official', eventTypes: ['workflow_progress'] }),
      local: normalized({ executor: 'local', eventTypes: [] }),
      officialArtifacts,
      localArtifacts,
      comparison,
      rerunCount: 2,
    })

    assert.equal(diff.status, 'different')
    assert.ok(diff.differences.includes('local missing required event workflow_progress'))
  })

  it('classifies unavailable official workflow surface separately', () => {
    const diff = compareNormalizedWorkflowResults({
      caseId: 'RUN-001',
      official: normalized({ executor: 'official', workflowSurfaceUnavailable: true }),
      local: normalized({ executor: 'local' }),
      officialArtifacts,
      localArtifacts,
      comparison,
      rerunCount: 0,
    })

    assert.equal(diff.status, 'official-surface-unavailable')
    assert.equal(diff.severity, 'intentional-divergence')
    assert.equal(diff.confidence, 'environmental')
  })

  it('marks missing local scriptPath as a P1 difference', () => {
    const diff = compareNormalizedWorkflowResults({
      caseId: 'RUN-001',
      official: normalized({ executor: 'official', hasScriptPath: true }),
      local: normalized({ executor: 'local', hasScriptPath: false }),
      officialArtifacts,
      localArtifacts,
      comparison,
      rerunCount: 2,
    })

    assert.equal(diff.status, 'different')
    assert.equal(diff.severity, 'P1')
    assert.equal(diff.confidence, 'confirmed')
    assert.ok(diff.differences.includes('local missing scriptPath'))
  })
})
