import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareNormalizedWorkflowResults } from './compare.js'
import { normalizeWorkflowExecutorResult } from './normalize.js'
import { renderDevelopmentGuideMarkdown, renderEvidenceMatrixMarkdown } from './report.js'
import type {
  WorkflowCompatibilityCase,
  WorkflowCompatibilityDiff,
  WorkflowCompatibilityReport,
  WorkflowExecutorResult,
} from './types.js'

export type WorkflowCompatibilityExecutor = (
  testCase: WorkflowCompatibilityCase,
  attempt: number,
) => Promise<WorkflowExecutorResult>

function score(diffs: WorkflowCompatibilityDiff[]): number {
  if (diffs.length === 0) return 0
  const same = diffs.filter(diff => diff.status === 'same').length
  return Math.round((same / diffs.length) * 100)
}

async function readExistingReport(outputRoot: string): Promise<WorkflowCompatibilityReport | undefined> {
  try {
    return JSON.parse(
      await readFile(join(outputRoot, 'workflow-compatibility-report.json'), 'utf8'),
    ) as WorkflowCompatibilityReport
  } catch {
    return undefined
  }
}

async function readArtifactData(result: WorkflowExecutorResult): Promise<{ files: string[]; metadata: Record<string, unknown> }> {
  let files: string[] = []
  let metadata: Record<string, unknown> = {}
  try {
    files = JSON.parse(await readFile(result.artifacts.filesManifestPath, 'utf8')) as string[]
  } catch {
    files = []
  }
  try {
    metadata = JSON.parse(await readFile(result.artifacts.metadataPath, 'utf8')) as Record<string, unknown>
  } catch {
    metadata = {}
  }
  return { files, metadata }
}

async function compareAttempt({
  testCase,
  officialExecutor,
  localExecutor,
  attempt,
  rerunCount,
}: {
  testCase: WorkflowCompatibilityCase
  officialExecutor: WorkflowCompatibilityExecutor
  localExecutor: WorkflowCompatibilityExecutor
  attempt: number
  rerunCount: number
}): Promise<WorkflowCompatibilityDiff> {
  const official = await officialExecutor(testCase, attempt)
  const local = await localExecutor(testCase, attempt)
  const officialNormalized = normalizeWorkflowExecutorResult(official, await readArtifactData(official))
  const localNormalized = normalizeWorkflowExecutorResult(local, await readArtifactData(local))

  return compareNormalizedWorkflowResults({
    caseId: testCase.id,
    official: officialNormalized,
    local: localNormalized,
    officialArtifacts: official.artifacts,
    localArtifacts: local.artifacts,
    comparison: testCase.comparison,
    rerunCount,
  })
}

export async function runWorkflowCompatibilityCases({
  cases,
  outputRoot,
  force,
  officialBinary = '/opt/homebrew/bin/claude',
  officialExecutor,
  localExecutor,
}: {
  cases: WorkflowCompatibilityCase[]
  outputRoot: string
  force: boolean
  officialBinary?: string
  officialExecutor: WorkflowCompatibilityExecutor
  localExecutor: WorkflowCompatibilityExecutor
}): Promise<WorkflowCompatibilityReport> {
  if (cases.length === 0) throw new Error('No workflow compatibility cases selected')
  if (force) await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  const existingReport = force ? undefined : await readExistingReport(outputRoot)
  const completedByCase = new Map(
    (existingReport?.diffs ?? []).map(diff => [diff.caseId, diff] as const),
  )
  const diffs: WorkflowCompatibilityDiff[] = []

  for (const testCase of cases) {
    const completed = completedByCase.get(testCase.id)
    if (completed) {
      diffs.push(completed)
      continue
    }
    const attempts: WorkflowCompatibilityDiff[] = [
      await compareAttempt({
        testCase,
        officialExecutor,
        localExecutor,
        attempt: 1,
        rerunCount: 0,
      }),
    ]

    if (attempts[0].status !== 'same') {
      for (let rerun = 1; rerun <= testCase.confirmation.rerunsOnDifference; rerun += 1) {
        attempts.push(
          await compareAttempt({
            testCase,
            officialExecutor,
            localExecutor,
            attempt: rerun + 1,
            rerunCount: rerun,
          }),
        )
      }
    }

    const lastDiff = attempts[attempts.length - 1]
    const firstSignature = JSON.stringify({
      status: attempts[0].status,
      differences: attempts[0].differences,
    })
    const stable = attempts.every(
      attempt =>
        JSON.stringify({ status: attempt.status, differences: attempt.differences }) ===
        firstSignature,
    )
    diffs.push(
      stable
        ? lastDiff
        : {
            ...lastDiff,
            status: 'flaky',
            confidence: 'flaky',
            rerunCount: attempts.length - 1,
            differences: [...new Set(attempts.flatMap(attempt => attempt.differences))],
          },
    )
  }

  const report: WorkflowCompatibilityReport = {
    generatedAt: new Date().toISOString(),
    officialBinary,
    totalCases: cases.length,
    completedCases: diffs.length,
    score: score(diffs),
    diffs,
  }

  await writeFile(join(outputRoot, 'workflow-compatibility-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(join(outputRoot, 'workflow-compatibility-evidence.md'), renderEvidenceMatrixMarkdown(report))
  await writeFile(join(outputRoot, 'workflow-compatibility-development-guide.md'), renderDevelopmentGuideMarkdown(report))

  return report
}
