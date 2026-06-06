import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  WorkflowCompatibilityCase,
  WorkflowCompatibilityDiff,
  WorkflowExecutorResult,
  WorkflowRunArtifacts,
} from './types.js'

describe('workflow compatibility shared types', () => {
  it('supports a complete compatibility case shape', () => {
    const testCase: WorkflowCompatibilityCase = {
      id: 'ARGS-001',
      title: 'object args through inline script',
      category: 'args',
      prompt: 'Run the fixture workflow with object args.',
      workflowName: 'args-object',
      args: { topic: 'compatibility' },
      fixtureFiles: {
        '.claude/workflows/args-object.js': 'export default workflow({ name: "Args Object", phases: [] })\n',
      },
      env: { CLAUDE_CODE_RECOVER_FEATURES: 'WORKFLOW_SCRIPTS' },
      timeoutMs: 120000,
      maxOutputBytes: 200000,
      comparison: {
        mode: 'schema',
        requiredEventTypes: ['workflow_progress'],
        proseFields: ['stdout'],
      },
      confirmation: {
        rerunsOnDifference: 2,
      },
    }

    assert.equal(testCase.id, 'ARGS-001')
    assert.equal(testCase.category, 'args')
    assert.equal(testCase.confirmation.rerunsOnDifference, 2)
  })

  it('supports executor result, artifacts, and diff shapes', () => {
    const artifacts: WorkflowRunArtifacts = {
      caseId: 'CTRL-001',
      executor: 'official',
      attempt: 1,
      workspacePath: '/tmp/workflow-compat/CTRL-001/official/attempt-1',
      command: ['/opt/homebrew/bin/claude', '--version'],
      env: {},
      stdoutPath: 'stdout.txt',
      stderrPath: 'stderr.txt',
      filesManifestPath: 'files.json',
      metadataPath: 'metadata.json',
    }

    const result: WorkflowExecutorResult = {
      artifacts,
      exitCode: 0,
      signal: null,
      durationMs: 50,
      stdout: '2.1.150 (Claude Code)\n',
      stderr: '',
      timedOut: false,
    }

    const diff: WorkflowCompatibilityDiff = {
      caseId: 'CTRL-001',
      status: 'same',
      severity: 'P2',
      confidence: 'confirmed',
      samePoints: ['exit code'],
      differences: [],
      likelySourceAreas: [],
      officialArtifacts: artifacts,
      localArtifacts: { ...artifacts, executor: 'local' },
      rerunCount: 0,
    }

    assert.equal(result.exitCode, 0)
    assert.equal(diff.status, 'same')
  })
})
