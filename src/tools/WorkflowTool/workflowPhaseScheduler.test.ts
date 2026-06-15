import assert from 'node:assert/strict'

import { workflowPhaseExecutionOrder } from './workflowPhaseScheduler.js'
import type { WorkflowDryRunPhase } from './workflowSpec.js'

function phase(id: string, dependsOn: string[] = []): WorkflowDryRunPhase {
  return {
    id,
    description: id,
    prompt: id,
    dependsOn,
    fanout: 1,
    concurrency: 1,
    review: 'none',
    permissionMode: 'plan',
  }
}

assert.deepEqual(
  workflowPhaseExecutionOrder([
    phase('summarize', ['scan']),
    phase('scan'),
    phase('publish', ['summarize']),
  ]).map(item => item.id),
  ['scan', 'summarize', 'publish'],
)

assert.deepEqual(
  workflowPhaseExecutionOrder([
    phase('alpha'),
    phase('beta'),
    phase('join', ['alpha', 'beta']),
  ]).map(item => item.id),
  ['alpha', 'beta', 'join'],
)

console.log('workflowPhaseScheduler.test.ts passed')
