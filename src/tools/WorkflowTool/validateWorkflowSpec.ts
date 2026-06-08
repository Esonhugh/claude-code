import { availableParallelism } from 'node:os'

import type {
  WorkflowDefaults,
  WorkflowDryRunPhase,
  WorkflowDryRunPlan,
  WorkflowPermissionMode,
  WorkflowReviewMode,
  WorkflowSpec,
} from './workflowSpec.js'

const SUPPORTED_REVIEW_MODES = new Set<WorkflowReviewMode>([
  'none',
  'cross-check',
  'adversarial',
  'synthesis',
])

const SUPPORTED_PERMISSION_MODES = new Set<WorkflowPermissionMode>([
  'default',
  'acceptEdits',
  'plan',
])

const DEFAULTS = {
  maxConcurrency: Math.min(16, Math.max(1, availableParallelism() - 2)),
  maxAgents: 1000,
  maxRetries: 0,
  fanout: 1,
  concurrency: 1,
  review: 'none' as WorkflowReviewMode,
  permissionMode: 'acceptEdits' as WorkflowPermissionMode,
  execution: 'agent' as const,
}

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(message)
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
}

function normalizeDefaults(defaults: WorkflowDefaults | undefined): WorkflowDryRunPlan['defaults'] {
  const normalized = {
    ...DEFAULTS,
    ...defaults,
  }

  assertPositiveInteger(normalized.maxConcurrency, 'defaults.maxConcurrency')
  assertPositiveInteger(normalized.maxAgents, 'defaults.maxAgents')
  if (!Number.isInteger(normalized.maxRetries) || normalized.maxRetries < 0) {
    throw new Error('defaults.maxRetries must be a non-negative integer')
  }
  assertPositiveInteger(normalized.fanout, 'defaults.fanout')
  assertPositiveInteger(normalized.concurrency, 'defaults.concurrency')

  if (normalized.concurrency > normalized.fanout) {
    throw new Error('defaults.concurrency must be less than or equal to defaults.fanout')
  }

  if (normalized.concurrency > normalized.maxConcurrency) {
    throw new Error('defaults.concurrency must be less than or equal to defaults.maxConcurrency')
  }

  if (!SUPPORTED_REVIEW_MODES.has(normalized.review)) {
    throw new Error(`Unsupported review mode: ${String(normalized.review)}`)
  }

  if (!SUPPORTED_PERMISSION_MODES.has(normalized.permissionMode)) {
    throw new Error(`Unsupported permission mode: ${String(normalized.permissionMode)}`)
  }

  if (normalized.execution !== 'agent' && normalized.execution !== 'team') {
    throw new Error(`Unsupported workflow execution mode: ${String(normalized.execution)}`)
  }

  return normalized
}

function assertAcyclic(phases: WorkflowDryRunPhase[]): void {
  const phaseById = new Map(phases.map(phase => [phase.id, phase]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(phaseId: string, path: string[]): void {
    if (visited.has(phaseId)) {
      return
    }

    if (visiting.has(phaseId)) {
      throw new Error(`Workflow dependency cycle detected: ${[...path, phaseId].join(' -> ')}`)
    }

    visiting.add(phaseId)

    const phase = phaseById.get(phaseId)
    if (!phase) {
      return
    }

    for (const dependencyId of phase.dependsOn) {
      visit(dependencyId, [...path, phaseId])
    }

    visiting.delete(phaseId)
    visited.add(phaseId)
  }

  for (const phase of phases) {
    visit(phase.id, [])
  }
}

function assertGlobalConcurrencyLimit(
  phases: WorkflowDryRunPhase[],
  maxConcurrency: number,
): void {
  const phaseById = new Map(phases.map(phase => [phase.id, phase]))
  const ancestorsById = new Map<string, Set<string>>()

  function ancestorsFor(phaseId: string): Set<string> {
    const cached = ancestorsById.get(phaseId)
    if (cached) return cached

    const ancestors = new Set<string>()
    const phase = phaseById.get(phaseId)!
    for (const dependencyId of phase.dependsOn) {
      ancestors.add(dependencyId)
      for (const ancestor of ancestorsFor(dependencyId)) {
        ancestors.add(ancestor)
      }
    }

    ancestorsById.set(phaseId, ancestors)
    return ancestors
  }

  for (const phase of phases) ancestorsFor(phase.id)

  function canOverlap(a: WorkflowDryRunPhase, b: WorkflowDryRunPhase): boolean {
    return !ancestorsById.get(a.id)!.has(b.id) && !ancestorsById.get(b.id)!.has(a.id)
  }

  const sorted = [...phases].sort((a, b) => b.concurrency - a.concurrency)
  const remainingConcurrency: number[] = new Array(sorted.length + 1).fill(0)
  for (let i = sorted.length - 1; i >= 0; i--) {
    remainingConcurrency[i] = remainingConcurrency[i + 1]! + sorted[i]!.concurrency
  }

  function search(index: number, selected: WorkflowDryRunPhase[], total: number): void {
    if (total > maxConcurrency) {
      throw new Error(
        `Workflow global concurrency can reach ${total}, exceeding defaults.maxConcurrency ${maxConcurrency}`,
      )
    }

    if (index >= sorted.length || total + remainingConcurrency[index]! <= maxConcurrency) {
      return
    }

    const phase = sorted[index]!
    if (selected.every(other => canOverlap(phase, other))) {
      search(index + 1, [...selected, phase], total + phase.concurrency)
    }
    search(index + 1, selected, total)
  }

  search(0, [], 0)
}

export function validateWorkflowSpec(spec: WorkflowSpec): WorkflowDryRunPlan {
  assertNonEmptyString(spec.name, 'Workflow name is required')
  assertNonEmptyString(spec.description, 'Workflow description is required')

  if (!Array.isArray(spec.phases) || spec.phases.length === 0) {
    throw new Error('Workflow must include at least one phase')
  }

  const defaults = normalizeDefaults(spec.defaults)
  const knownPhaseIds = new Set<string>()

  for (const phase of spec.phases) {
    assertNonEmptyString(phase.id, 'Workflow phase id is required')

    const phaseId = phase.id.trim()
    if (knownPhaseIds.has(phaseId)) {
      throw new Error(`Workflow phase id must be unique: ${phaseId}`)
    }

    knownPhaseIds.add(phaseId)
  }

  const phases = spec.phases.map<WorkflowDryRunPhase>(phase => {
    assertNonEmptyString(phase.description, `Workflow phase ${phase.id} description is required`)
    assertNonEmptyString(phase.prompt, `Workflow phase ${phase.id} prompt is required`)

    const id = phase.id.trim()
    const dependsOn = (phase.dependsOn ?? []).map(dependencyId => {
      assertNonEmptyString(dependencyId, `Workflow phase ${id} dependency id is required`)
      return dependencyId.trim()
    })

    for (const dependencyId of dependsOn) {
      if (!knownPhaseIds.has(dependencyId)) {
        throw new Error(`Workflow phase ${id} has unknown dependency: ${dependencyId}`)
      }

      if (dependencyId === id) {
        throw new Error(`Workflow phase ${id} cannot depend on itself`)
      }
    }

    const fanout = phase.fanout ?? defaults.fanout
    const concurrency = phase.concurrency ?? defaults.concurrency
    const review = phase.review ?? defaults.review
    const permissionMode = phase.permissionMode ?? defaults.permissionMode

    if (spec.scriptResult !== undefined) {
      assertNonNegativeInteger(fanout, `Workflow phase ${id} fanout`)
    } else {
      assertPositiveInteger(fanout, `Workflow phase ${id} fanout`)
    }
    assertPositiveInteger(concurrency, `Workflow phase ${id} concurrency`)

    if (fanout > 0 && concurrency > fanout) {
      throw new Error(`Workflow phase ${id} concurrency must be less than or equal to fanout`)
    }

    if (concurrency > defaults.maxConcurrency) {
      throw new Error(`Workflow phase ${id} concurrency must be less than or equal to defaults.maxConcurrency`)
    }

    if (!SUPPORTED_REVIEW_MODES.has(review)) {
      throw new Error(`Unsupported review mode for workflow phase ${id}: ${String(review)}`)
    }

    if (!SUPPORTED_PERMISSION_MODES.has(permissionMode)) {
      throw new Error(`Unsupported permission mode for workflow phase ${id}: ${String(permissionMode)}`)
    }

    return {
      id,
      description: phase.description.trim(),
      prompt: phase.prompt.trim(),
      ...(phase.displayName?.trim() ? { displayName: phase.displayName.trim() } : {}),
      dependsOn,
      fanout,
      concurrency,
      review,
      permissionMode,
      agentType: phase.agentType ?? defaults.agentType,
      model: phase.model ?? defaults.model,
      ...(phase.agentLabels ? { agentLabels: phase.agentLabels } : {}),
      ...(phase.agentPrompts ? { agentPrompts: phase.agentPrompts } : {}),
    }
  })

  assertAcyclic(phases)
  assertGlobalConcurrencyLimit(phases, defaults.maxConcurrency)

  const totalAgents = phases.reduce((sum, phase) => sum + phase.fanout, 0)
  if (totalAgents > defaults.maxAgents) {
    throw new Error(`Workflow planned agents ${totalAgents} exceeds defaults.maxAgents ${defaults.maxAgents}`)
  }

  return {
    name: spec.name.trim(),
    description: spec.description.trim(),
    defaults,
    phases,
    totalAgents,
    output: spec.output,
    runtime: spec.runtime,
    sourcePath: spec.sourcePath,
    runScriptSnapshot: spec.runScriptSnapshot,
    meta: spec.meta,
    scriptResult: spec.scriptResult,
  }
}
