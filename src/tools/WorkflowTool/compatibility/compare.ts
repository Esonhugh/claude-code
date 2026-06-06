import type {
  WorkflowCompatibilityDiff,
  WorkflowDiffSeverity,
  WorkflowComparisonMode,
  WorkflowNormalizedResult,
  WorkflowRunArtifacts,
} from './types.js'

function stableMetadata(metadata: Record<string, unknown>): string {
  const { durationMs, ...stable } = metadata
  void durationMs
  return JSON.stringify(stable)
}

function severityFor(differences: string[]): WorkflowDiffSeverity {
  if (differences.some(difference => difference.includes('exit code') || difference.includes('timed out'))) {
    return 'P0'
  }
  if (differences.some(difference => difference.includes('scriptPath') || difference.includes('workflowRunId'))) {
    return 'P1'
  }
  return 'P2'
}

export function compareNormalizedWorkflowResults({
  caseId,
  official,
  local,
  officialArtifacts,
  localArtifacts,
  comparison,
  rerunCount,
}: {
  caseId: string
  official: WorkflowNormalizedResult
  local: WorkflowNormalizedResult
  officialArtifacts: WorkflowRunArtifacts
  localArtifacts: WorkflowRunArtifacts
  comparison: {
    mode: WorkflowComparisonMode
    requiredEventTypes: string[]
    proseFields: string[]
  }
  rerunCount: number
}): WorkflowCompatibilityDiff {
  if (official.workflowSurfaceUnavailable) {
    return {
      caseId,
      status: 'official-surface-unavailable',
      severity: 'intentional-divergence',
      confidence: 'environmental',
      samePoints: [],
      differences: ['official Workflow tool surface unavailable in this execution mode'],
      likelySourceAreas: ['officialBinarySurface'],
      officialArtifacts,
      localArtifacts,
      rerunCount,
    }
  }

  const samePoints: string[] = []
  const differences: string[] = []

  if (official.exitCode === local.exitCode) samePoints.push('exit code')
  else differences.push(`exit code official=${official.exitCode} local=${local.exitCode}`)

  if (official.timedOut === local.timedOut) samePoints.push('timeout state')
  else differences.push(`timed out official=${official.timedOut} local=${local.timedOut}`)

  if (official.hasWorkflowRunId === local.hasWorkflowRunId) samePoints.push('workflowRunId presence')
  else differences.push(local.hasWorkflowRunId ? 'official missing workflowRunId' : 'local missing workflowRunId')

  if (official.hasScriptPath === local.hasScriptPath) samePoints.push('scriptPath presence')
  else differences.push(local.hasScriptPath ? 'official missing scriptPath' : 'local missing scriptPath')

  const officialEvents = official.eventTypes.join(',')
  const localEvents = local.eventTypes.join(',')
  if (officialEvents === localEvents) samePoints.push('event types')
  else differences.push(`event types official=${officialEvents} local=${localEvents}`)

  for (const eventType of comparison.requiredEventTypes) {
    if (!official.eventTypes.includes(eventType)) {
      differences.push(`official missing required event ${eventType}`)
    }
    if (!local.eventTypes.includes(eventType)) {
      differences.push(`local missing required event ${eventType}`)
    }
  }

  const officialFiles = official.filePaths.join(',')
  const localFiles = local.filePaths.join(',')
  if (officialFiles === localFiles) samePoints.push('file paths')
  else differences.push(`file paths official=${officialFiles} local=${localFiles}`)

  const officialMetadata = stableMetadata(official.metadata)
  const localMetadata = stableMetadata(local.metadata)
  if (officialMetadata === localMetadata) samePoints.push('metadata')
  else differences.push(`metadata official=${officialMetadata} local=${localMetadata}`)

  return {
    caseId,
    status: differences.length === 0 ? 'same' : 'different',
    severity: severityFor(differences),
    confidence: rerunCount >= 2 ? 'confirmed' : 'single-run',
    samePoints,
    differences,
    likelySourceAreas: differences.map(difference => {
      if (difference.includes('scriptPath')) return 'workflowScriptPersistence'
      if (difference.includes('workflowRunId')) return 'workflowRunSessions'
      if (difference.includes('event types')) return 'runWorkflow'
      if (difference.includes('file paths') || difference.includes('metadata')) return 'workflowRunSessions'
      return 'WorkflowFacadeTool'
    }),
    officialArtifacts,
    localArtifacts,
    rerunCount,
  }
}
