import assert from 'node:assert/strict'

import { createWorkflowOrchestrator } from './workflowOrchestrator.js'

const orchestrator = createWorkflowOrchestrator({
  workflowRunId: 'wf_test_orchestrator',
  maxAgents: 4,
})

const first = orchestrator.agent({
  label: 'research-a',
  prompt: 'Research A',
})
const second = orchestrator.agent({
  label: 'research-b',
  prompt: 'Research B',
})
const results = await orchestrator.parallel([first, second])

assert.deepEqual(results.map(item => item.output), [
  '{{agent:research-a}}',
  '{{agent:research-b}}',
])
assert.deepEqual(orchestrator.toSpec().phases.map(phase => phase.id), [
  'research-a',
  'research-b',
])

const loopOrchestrator = createWorkflowOrchestrator({
  workflowRunId: 'wf_test_loop',
  maxAgents: 5,
})
await loopOrchestrator.loopUntil({
  label: 'verify-loop',
  maxIterations: 2,
  run: iteration =>
    loopOrchestrator.agent({
      label: `verify-${iteration}`,
      prompt: `Verify iteration ${iteration}`,
    }),
  isDone: result => result.output.includes('verify-1'),
})
assert.deepEqual(loopOrchestrator.toSpec().phases.map(phase => phase.id), [
  'verify-1',
])

const reviewOrchestrator = createWorkflowOrchestrator({
  workflowRunId: 'wf_test_review',
  maxAgents: 4,
})
await reviewOrchestrator.review({ label: 'review', prompt: 'Review claims' })
await reviewOrchestrator.refute({ label: 'refute', prompt: 'Refute claims' })
await reviewOrchestrator.vote({
  label: 'synthesis',
  prompt: 'Synthesize verified claims',
  dependsOn: ['review', 'refute'],
})
assert.deepEqual(
  reviewOrchestrator.toSpec().phases.map(phase => [phase.id, phase.review]),
  [
    ['review', 'cross-check'],
    ['refute', 'adversarial'],
    ['synthesis', 'synthesis'],
  ],
)

console.log('workflowOrchestrator.test.ts passed')
