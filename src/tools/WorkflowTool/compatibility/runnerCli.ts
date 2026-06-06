import { createCaseWorkspace, writeExecutorArtifacts } from './artifacts.js'
import { getWorkflowCompatibilityCases } from './caseMatrix.js'
import {
  buildLocalExecutionPlan,
  buildOfficialExecutionPlan,
} from './executors.js'
import { runCommand } from './runCommand.js'
import { runWorkflowCompatibilityCases } from './runner.js'
import type {
  WorkflowCompatibilityCase,
  WorkflowExecutorName,
  WorkflowExecutorResult,
} from './types.js'

function selectedCases(cases: WorkflowCompatibilityCase[], args: string[]): WorkflowCompatibilityCase[] {
  const categoryArg = args.find(arg => arg.startsWith('--category='))
  const caseArg = args.find(arg => arg.startsWith('--case='))
  const limitArg = args.find(arg => arg.startsWith('--limit='))
  let selected = cases
  if (categoryArg) {
    const category = categoryArg.slice('--category='.length)
    selected = selected.filter(testCase => testCase.category === category)
  }
  if (caseArg) {
    const id = caseArg.slice('--case='.length)
    selected = selected.filter(testCase => testCase.id === id)
  }
  if (limitArg) {
    selected = selected.slice(0, Number(limitArg.slice('--limit='.length)))
  }
  return selected
}

async function executeCase({
  testCase,
  executor,
  attempt,
  projectRoot,
  outputRoot,
  officialBinary,
}: {
  testCase: WorkflowCompatibilityCase
  executor: WorkflowExecutorName
  attempt: number
  projectRoot: string
  outputRoot: string
  officialBinary: string
}): Promise<WorkflowExecutorResult> {
  const workspacePath = await createCaseWorkspace({
    outputRoot,
    caseId: testCase.id,
    executor,
    attempt,
    fixtureFiles: testCase.fixtureFiles,
  })

  const plan =
    executor === 'official'
      ? buildOfficialExecutionPlan({ testCase, workspacePath, officialBinary })
      : buildLocalExecutionPlan({ testCase, workspacePath, projectRoot })

  const commandResult = await runCommand({
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    env: plan.env,
    timeoutMs: plan.timeoutMs ?? testCase.timeoutMs,
    maxOutputBytes: testCase.maxOutputBytes,
  })

  const artifacts = await writeExecutorArtifacts({
    workspacePath,
    caseId: testCase.id,
    executor,
    attempt,
    command: [plan.command, ...plan.args],
    env: plan.env,
    stdout: commandResult.stdout,
    stderr: commandResult.stderr,
    metadata: {
      exitCode: commandResult.exitCode,
      signal: commandResult.signal,
      durationMs: commandResult.durationMs,
      timedOut: commandResult.timedOut,
    },
  })

  return { ...commandResult, artifacts }
}

export async function main({
  projectRoot,
  outputRoot,
  officialBinary,
  args,
}: {
  projectRoot: string
  outputRoot: string
  officialBinary: string
  args: string[]
}): Promise<void> {
  const cases = selectedCases(getWorkflowCompatibilityCases(), args)
  await runWorkflowCompatibilityCases({
    cases,
    outputRoot,
    force: args.includes('--force'),
    officialBinary,
    officialExecutor: (testCase, attempt) =>
      executeCase({ testCase, executor: 'official', attempt, projectRoot, outputRoot, officialBinary }),
    localExecutor: (testCase, attempt) =>
      executeCase({ testCase, executor: 'local', attempt, projectRoot, outputRoot, officialBinary }),
  })
}
