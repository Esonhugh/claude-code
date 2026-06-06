import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { reconstructWorkflowStructures } from './reconstruct.js'

describe('workflow structure reconstruction', () => {
  it('infers workflow purpose, phases, and agent roles from evidence text', () => {
    const reconstructions = reconstructWorkflowStructures([
      {
        caseId: 'EXP-006',
        workflowName: 'deep-research',
        evidenceText: 'deep-research gathers sources, runs research agents, reviews findings, and synthesizes a final report. workflow_phase research workflow_agent reviewer workflow_phase synthesis',
      },
    ])

    assert.equal(reconstructions.length, 1)
    assert.equal(reconstructions[0].workflowName, 'deep-research')
    assert.ok(reconstructions[0].purpose.includes('research'))
    assert.deepEqual(reconstructions[0].evidenceCaseIds, ['EXP-006'])
    assert.ok(reconstructions[0].phases.some(phase => phase.id === 'research'))
    assert.ok(reconstructions[0].agentRoles.some(agent => agent.role === 'reviewer'))
  })
})
