import type { WorkflowStructureReconstruction } from './types.js'

export type WorkflowEvidence = {
  caseId: string
  workflowName: string
  evidenceText: string
}

function includesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase()
  return terms.some(term => lower.includes(term))
}

export function reconstructWorkflowStructures(
  evidence: WorkflowEvidence[],
): WorkflowStructureReconstruction[] {
  const byWorkflow = new Map<string, WorkflowEvidence[]>()
  for (const item of evidence) {
    const items = byWorkflow.get(item.workflowName) ?? []
    items.push(item)
    byWorkflow.set(item.workflowName, items)
  }

  return [...byWorkflow.entries()].map(([workflowName, items]) => {
    const text = items.map(item => item.evidenceText).join('\n').toLowerCase()
    const phases: WorkflowStructureReconstruction['phases'] = []
    const agentRoles: WorkflowStructureReconstruction['agentRoles'] = []

    if (includesAny(text, ['research', 'investigate'])) {
      phases.push({ id: 'research', title: 'Research', inferredFrom: items.map(item => item.caseId) })
    }
    if (includesAny(text, ['review', 'reviewer'])) {
      phases.push({ id: 'review', title: 'Review', inferredFrom: items.map(item => item.caseId) })
      agentRoles.push({ role: 'reviewer', inferredFrom: items.map(item => item.caseId) })
    }
    if (includesAny(text, ['synthesis', 'synthesize', 'final report'])) {
      phases.push({ id: 'synthesis', title: 'Synthesis', inferredFrom: items.map(item => item.caseId) })
      agentRoles.push({ role: 'synthesizer', inferredFrom: items.map(item => item.caseId) })
    }
    if (phases.length === 0) {
      phases.push({ id: 'main', title: 'Main', inferredFrom: items.map(item => item.caseId) })
    }

    return {
      workflowName,
      purpose: includesAny(text, ['research'])
        ? 'Runs research-oriented workflow phases and synthesizes findings.'
        : 'Runs an observed official workflow pattern.',
      acceptedArgs: ['string', 'object', 'omitted'],
      phases,
      agentRoles,
      knownDifferences: [],
      evidenceCaseIds: items.map(item => item.caseId),
    }
  })
}
