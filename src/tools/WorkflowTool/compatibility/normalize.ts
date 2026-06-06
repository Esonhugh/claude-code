import type { WorkflowExecutorResult, WorkflowNormalizedResult } from './types.js'

const EVENT_PATTERN = /\bworkflow_(?:progress|agent|phase|log)\b/g

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function workflowSurfaceUnavailable(text: string): boolean {
  return /no `?Workflow`? tool is available|Workflow tool is not available|can't call `?Workflow|cannot call `?Workflow/i.test(text)
}

function bucketText(text: string): string {
  if (text.trim().length === 0) return 'empty'
  const hasMechanics = /workflowRunId|scriptPath|workflow_/.test(text)
  return hasMechanics ? 'workflow-mechanics-and-prose' : 'prose-only'
}

export function normalizeWorkflowExecutorResult(
  result: WorkflowExecutorResult,
  artifactData: { files: string[]; metadata: Record<string, unknown> },
): WorkflowNormalizedResult {
  const combinedText = `${result.stdout}\n${result.stderr}`
  const eventTypes = uniqueSorted(combinedText.match(EVENT_PATTERN) ?? [])

  return {
    caseId: result.artifacts.caseId,
    executor: result.artifacts.executor,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    eventTypes,
    hasWorkflowRunId: /(?:workflowRunId|Workflow run ID)\s*[:=]/i.test(combinedText),
    hasScriptPath: /(?:scriptPath|Script path)\s*[:=]/i.test(combinedText),
    workflowSurfaceUnavailable: workflowSurfaceUnavailable(combinedText),
    stdoutBucket: bucketText(result.stdout),
    stderrBucket: bucketText(result.stderr),
    filePaths: artifactData.files.map(file => file.split('\t')[0]).sort(),
    metadata: artifactData.metadata,
  }
}
