import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runWorkflowCompatibilityCases } from './runner.js'
import type { WorkflowCompatibilityCase, WorkflowExecutorResult } from './types.js'

async function makeResult(
  testCase: WorkflowCompatibilityCase,
  executor: 'official' | 'local',
  stdout: string,
  outputRoot: string,
  attempt: number,
  files: string[] = [],
): Promise<WorkflowExecutorResult> {
  const workspacePath = join(outputRoot, testCase.id, executor, `attempt-${attempt}`)
  const filesManifestPath = join(workspacePath, 'files.json')
  const metadataPath = join(workspacePath, 'metadata.json')
  await mkdir(workspacePath, { recursive: true })
  await writeFile(filesManifestPath, `${JSON.stringify(files)}\n`)
  await writeFile(metadataPath, `${JSON.stringify({ attempt })}\n`)
  return {
    artifacts: {
      caseId: testCase.id,
      executor,
      attempt,
      workspacePath,
      command: ['fake'],
      env: {},
      stdoutPath: join(workspacePath, 'stdout.txt'),
      stderrPath: join(workspacePath, 'stderr.txt'),
      filesManifestPath,
      metadataPath,
    },
    exitCode: 0,
    signal: null,
    durationMs: 1,
    stdout,
    stderr: '',
    timedOut: false,
  }
}

const testCase: WorkflowCompatibilityCase = {
  id: 'RUN-001',
  title: 'runner smoke',
  category: 'runtime',
  prompt: 'Run smoke.',
  fixtureFiles: {},
  env: {},
  timeoutMs: 30000,
  maxOutputBytes: 50000,
  comparison: { mode: 'schema', requiredEventTypes: ['workflow_progress'], proseFields: ['stdout'] },
  confirmation: { rerunsOnDifference: 2 },
}

describe('workflow compatibility runner', () => {
  it('runs official and local executors and reruns confirmed differences', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'workflow-compat-runner-'))
    let officialRuns = 0
    let localRuns = 0
    try {
      const report = await runWorkflowCompatibilityCases({
        cases: [testCase],
        outputRoot,
        force: true,
        officialBinary: '/custom/claude',
        officialExecutor: async (testCase, attempt) => {
          officialRuns += 1
          return makeResult(
            testCase,
            'official',
            'workflowRunId: wf_1\nscriptPath: official.js\nworkflow_progress\n',
            outputRoot,
            attempt,
            ['.claude/workflow-runs/wf_1/session.json\t100'],
          )
        },
        localExecutor: async (testCase, attempt) => {
          localRuns += 1
          return makeResult(testCase, 'local', 'workflowRunId: wf_1\nworkflow_progress\n', outputRoot, attempt)
        },
      })

      assert.equal(report.totalCases, 1)
      assert.equal(report.completedCases, 1)
      assert.equal(report.officialBinary, '/custom/claude')
      assert.equal(report.diffs[0].status, 'different')
      assert.equal(report.diffs[0].rerunCount, 2)
      assert.equal(officialRuns, 3)
      assert.equal(localRuns, 3)
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  })

  it('classifies inconsistent reruns as flaky', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'workflow-compat-runner-'))
    try {
      const report = await runWorkflowCompatibilityCases({
        cases: [testCase],
        outputRoot,
        force: true,
        officialExecutor: async (testCase, attempt) =>
          makeResult(testCase, 'official', 'workflowRunId: wf_1\nscriptPath: official.js\nworkflow_progress\n', outputRoot, attempt),
        localExecutor: async (testCase, attempt) =>
          makeResult(
            testCase,
            'local',
            attempt === 1
              ? 'workflowRunId: wf_1\nworkflow_progress\n'
              : 'workflowRunId: wf_1\nscriptPath: local.js\nworkflow_progress\n',
            outputRoot,
            attempt,
          ),
      })

      assert.equal(report.diffs[0].status, 'flaky')
      assert.equal(report.diffs[0].confidence, 'flaky')
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  })

  it('skips completed cases when force is false', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'workflow-compat-runner-'))
    let officialRuns = 0
    let localRuns = 0
    try {
      await writeFile(
        join(outputRoot, 'workflow-compatibility-report.json'),
        `${JSON.stringify({
          generatedAt: '2026-06-06T00:00:00.000Z',
          officialBinary: '/opt/homebrew/bin/claude',
          totalCases: 1,
          completedCases: 1,
          score: 100,
          diffs: [
            {
              caseId: 'RUN-001',
              status: 'same',
              severity: 'P2',
              confidence: 'single-run',
              samePoints: ['exit code'],
              differences: [],
              likelySourceAreas: [],
              officialArtifacts: {
                caseId: 'RUN-001',
                executor: 'official',
                attempt: 1,
                workspacePath: '/tmp/official',
                command: ['fake'],
                env: {},
                stdoutPath: 'stdout.txt',
                stderrPath: 'stderr.txt',
                filesManifestPath: 'files.json',
                metadataPath: 'metadata.json',
              },
              localArtifacts: {
                caseId: 'RUN-001',
                executor: 'local',
                attempt: 1,
                workspacePath: '/tmp/local',
                command: ['fake'],
                env: {},
                stdoutPath: 'stdout.txt',
                stderrPath: 'stderr.txt',
                filesManifestPath: 'files.json',
                metadataPath: 'metadata.json',
              },
              rerunCount: 0,
            },
          ],
        })}\n`,
      )

      const report = await runWorkflowCompatibilityCases({
        cases: [testCase],
        outputRoot,
        force: false,
        officialExecutor: async (testCase, attempt) => {
          officialRuns += 1
          return makeResult(testCase, 'official', '', outputRoot, attempt)
        },
        localExecutor: async (testCase, attempt) => {
          localRuns += 1
          return makeResult(testCase, 'local', '', outputRoot, attempt)
        },
      })

      assert.equal(report.completedCases, 1)
      assert.equal(officialRuns, 0)
      assert.equal(localRuns, 0)
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  })

  it('rejects empty case selections', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'workflow-compat-runner-'))
    try {
      await assert.rejects(
        runWorkflowCompatibilityCases({
          cases: [],
          outputRoot,
          force: true,
          officialExecutor: async (testCase, attempt) =>
            makeResult(testCase, 'official', '', outputRoot, attempt),
          localExecutor: async (testCase, attempt) =>
            makeResult(testCase, 'local', '', outputRoot, attempt),
        }),
        /No workflow compatibility cases selected/,
      )
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  })
})
