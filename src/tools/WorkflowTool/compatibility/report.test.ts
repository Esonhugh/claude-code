import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderDevelopmentGuideMarkdown, renderEvidenceMatrixMarkdown } from './report.js'
import type { WorkflowCompatibilityDiff, WorkflowCompatibilityReport } from './types.js'

const artifacts = {
  caseId: 'RUN-001',
  executor: 'official' as const,
  attempt: 1,
  workspacePath: '/tmp/official',
  command: ['claude', '-p', 'line one\nline | two'],
  env: {},
  stdoutPath: 'stdout.txt',
  stderrPath: 'stderr.txt',
  filesManifestPath: 'files.json',
  metadataPath: 'metadata.json',
}

const diff: WorkflowCompatibilityDiff = {
  caseId: 'RUN-001',
  status: 'different',
  severity: 'P1',
  confidence: 'confirmed',
  samePoints: ['exit code'],
  differences: ['local missing scriptPath'],
  likelySourceAreas: ['workflowScriptPersistence'],
  officialArtifacts: artifacts,
  localArtifacts: { ...artifacts, executor: 'local', workspacePath: '/tmp/local' },
  rerunCount: 2,
}

const report: WorkflowCompatibilityReport = {
  generatedAt: '2026-06-06T00:00:00.000Z',
  officialBinary: '/opt/homebrew/bin/claude',
  totalCases: 1,
  completedCases: 1,
  score: 86,
  diffs: [diff],
}

describe('workflow compatibility reports', () => {
  it('renders a per-case evidence matrix', () => {
    const markdown = renderEvidenceMatrixMarkdown(report)
    assert.match(markdown, /# Workflow Compatibility Evidence Matrix/)
    assert.match(markdown, /RUN-001/)
    assert.match(markdown, /local missing scriptPath/)
    assert.match(markdown, /claude/)
    assert.match(markdown, /exit code/)
    assert.match(markdown, /line one\\nline \\| two/)
  })

  it('renders a development guide grouped by source area', () => {
    const markdown = renderDevelopmentGuideMarkdown(report)
    assert.match(markdown, /# Workflow Compatibility Development Guide/)
    assert.match(markdown, /workflowScriptPersistence/)
    assert.match(markdown, /RUN-001/)
  })
})
