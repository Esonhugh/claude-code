import { join } from 'node:path'
import type { WorkflowCompatibilityCase } from './types.js'

export type WorkflowExecutionPlan = {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  timeoutMs?: number
}

function buildPrompt(testCase: WorkflowCompatibilityCase): string {
  if (!testCase.workflowName) return testCase.prompt
  const input = {
    name: testCase.workflowName,
    ...(testCase.args === undefined ? {} : { args: testCase.args }),
  }
  return `${testCase.prompt}\n\nRun the target workflow by calling Workflow(${JSON.stringify(input, null, 2)}).`
}

export function buildOfficialExecutionPlan({
  testCase,
  workspacePath,
  officialBinary,
}: {
  testCase: WorkflowCompatibilityCase
  workspacePath: string
  officialBinary: string
}): WorkflowExecutionPlan {
  return {
    command: officialBinary,
    args: ['-p', '--bare', buildPrompt(testCase)],
    cwd: workspacePath,
    env: testCase.env,
    timeoutMs: testCase.workflowName ? Math.min(testCase.timeoutMs, 30000) : testCase.timeoutMs,
  }
}

export function buildLocalExecutionPlan({
  testCase,
  workspacePath,
  projectRoot,
}: {
  testCase: WorkflowCompatibilityCase
  workspacePath: string
  projectRoot: string
}): WorkflowExecutionPlan {
  return {
    command: process.execPath,
    args: [join(projectRoot, 'dist', 'cli.js'), '-p', '--bare', buildPrompt(testCase)],
    cwd: workspacePath,
    env: testCase.env,
  }
}
