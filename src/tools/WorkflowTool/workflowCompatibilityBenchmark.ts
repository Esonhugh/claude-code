export type WorkflowObservation = {
  tool?: string
  workflowRunId?: string
  scriptPath?: string
  events?: Array<{ type?: string; [key: string]: unknown }>
  argsKind?: string
  supportsScriptPathRerun?: boolean
  supportsUserWorkflowDiscovery?: boolean
}

export type WorkflowCompatibilityFlags = {
  hasWorkflowFacade: boolean
  hasWorkflowRunId: boolean
  hasScriptPath: boolean
  hasOfficialProgressEvents: boolean
  structuredArgs: boolean
  scriptPathRerun: boolean
  userWorkflowDiscovery: boolean
}

export type WorkflowCompatibilityReport = {
  score: number
  gaps: Array<keyof WorkflowCompatibilityFlags>
  official: WorkflowCompatibilityFlags
  local: WorkflowCompatibilityFlags
}

const OFFICIAL_EVENT_TYPES = new Set([
  'workflow_progress',
  'workflow_agent',
  'workflow_phase',
  'workflow_log',
])

export function normalizeWorkflowObservation(
  observation: WorkflowObservation,
): WorkflowCompatibilityFlags {
  const eventTypes = new Set((observation.events ?? []).map(event => event.type))

  return {
    hasWorkflowFacade: observation.tool === 'Workflow',
    hasWorkflowRunId: typeof observation.workflowRunId === 'string',
    hasScriptPath: typeof observation.scriptPath === 'string',
    hasOfficialProgressEvents: [...OFFICIAL_EVENT_TYPES].every(type =>
      eventTypes.has(type),
    ),
    structuredArgs: observation.argsKind !== undefined && observation.argsKind !== 'string',
    scriptPathRerun: observation.supportsScriptPathRerun === true,
    userWorkflowDiscovery: observation.supportsUserWorkflowDiscovery === true,
  }
}

export function compareWorkflowCompatibility({
  official,
  local,
}: {
  official: WorkflowObservation
  local: WorkflowObservation
}): WorkflowCompatibilityReport {
  const officialFlags = normalizeWorkflowObservation(official)
  const localFlags = normalizeWorkflowObservation(local)
  const keys = Object.keys(officialFlags) as Array<keyof WorkflowCompatibilityFlags>
  const relevantKeys = keys.filter(key => officialFlags[key])
  const gaps = relevantKeys.filter(key => !localFlags[key])
  const score =
    relevantKeys.length === 0
      ? 100
      : Math.round(((relevantKeys.length - gaps.length) / relevantKeys.length) * 100)

  return {
    score,
    gaps,
    official: officialFlags,
    local: localFlags,
  }
}
