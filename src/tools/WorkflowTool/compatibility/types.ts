export type WorkflowCompatibilityCategory =
  | 'official-export'
  | 'general-task'
  | 'args'
  | 'discovery'
  | 'runtime'
  | 'control'
  | 'error'
  | 'long-running'

export type WorkflowComparisonMode = 'exact' | 'schema' | 'semantic' | 'manual'

export type WorkflowExecutorName = 'official' | 'local'

export type WorkflowDiffStatus =
  | 'same'
  | 'different'
  | 'missing-official'
  | 'missing-local'
  | 'flaky'
  | 'environmental'
  | 'official-surface-unavailable'

export type WorkflowDiffSeverity = 'P0' | 'P1' | 'P2' | 'intentional-divergence'

export type WorkflowDiffConfidence = 'single-run' | 'confirmed' | 'flaky' | 'environmental'

export type WorkflowCompatibilityCase = {
  id: string
  title: string
  category: WorkflowCompatibilityCategory
  prompt: string
  workflowName?: string
  args?: unknown
  fixtureFiles: Record<string, string>
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
  comparison: {
    mode: WorkflowComparisonMode
    requiredEventTypes: string[]
    proseFields: string[]
  }
  confirmation: {
    rerunsOnDifference: number
  }
}

export type WorkflowRunArtifacts = {
  caseId: string
  executor: WorkflowExecutorName
  attempt: number
  workspacePath: string
  command: string[]
  env: Record<string, string>
  stdoutPath: string
  stderrPath: string
  filesManifestPath: string
  metadataPath: string
}

export type WorkflowExecutorResult = {
  artifacts: WorkflowRunArtifacts
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type WorkflowNormalizedResult = {
  caseId: string
  executor: WorkflowExecutorName
  exitCode: number | null
  timedOut: boolean
  eventTypes: string[]
  hasWorkflowRunId: boolean
  hasScriptPath: boolean
  workflowSurfaceUnavailable: boolean
  stdoutBucket: string
  stderrBucket: string
  filePaths: string[]
  metadata: Record<string, unknown>
}

export type WorkflowCompatibilityDiff = {
  caseId: string
  status: WorkflowDiffStatus
  severity: WorkflowDiffSeverity
  confidence: WorkflowDiffConfidence
  samePoints: string[]
  differences: string[]
  likelySourceAreas: string[]
  officialArtifacts: WorkflowRunArtifacts
  localArtifacts: WorkflowRunArtifacts
  rerunCount: number
}

export type WorkflowCompatibilityReport = {
  generatedAt: string
  officialBinary: string
  totalCases: number
  completedCases: number
  score: number
  diffs: WorkflowCompatibilityDiff[]
}

export type WorkflowStructureReconstruction = {
  workflowName: string
  purpose: string
  acceptedArgs: string[]
  phases: Array<{
    id: string
    title: string
    inferredFrom: string[]
  }>
  agentRoles: Array<{
    role: string
    inferredFrom: string[]
  }>
  knownDifferences: string[]
  evidenceCaseIds: string[]
}
