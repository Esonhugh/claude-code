import assert from 'node:assert/strict'

import { formatWorkflowDryRun } from './formatWorkflowDryRun.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'
import type { WorkflowSpec } from './workflowSpec.js'

const deepResearchWorkflow = {
  name: 'Deep Research Dry Run',
  description: 'Coordinate parallel research, cross-checking, and synthesis before execution support exists.',
  phases: [
    {
      id: 'research',
      description: 'Research current evidence from independent angles.',
      prompt: 'Investigate the topic and collect evidence with citations.',
      fanout: 4,
      agentType: 'researcher',
      model: 'claude-sonnet-4-5',
    },
    {
      id: 'cross-check',
      description: 'Cross-check the research findings for contradictions.',
      prompt: 'Review research outputs and identify unsupported claims.',
      dependsOn: ['research'],
      fanout: 2,
      concurrency: 2,
      review: 'cross-check',
    },
    {
      id: 'synthesis',
      description: 'Synthesize the reviewed findings into a final answer.',
      prompt: 'Produce a concise synthesis using only validated claims.',
      dependsOn: ['cross-check'],
      review: 'synthesis',
    },
  ],
  output: {
    format: 'markdown',
    description: 'A concise research brief with verified claims.',
  },
} satisfies WorkflowSpec

const plan = validateWorkflowSpec(deepResearchWorkflow)

assert.equal(plan.name, 'Deep Research Dry Run')
assert.equal(plan.totalAgents, 7)
assert.equal(plan.defaults.maxConcurrency, 4)
assert.equal(plan.defaults.maxAgents, 32)
assert.equal(plan.defaults.maxRetries, 0)
assert.equal(plan.defaults.execution, 'agent')
assert.equal(plan.defaults.fanout, 1)
assert.equal(plan.defaults.concurrency, 1)
assert.equal(plan.defaults.review, 'none')
assert.equal(plan.defaults.permissionMode, 'default')

const researchPhase = plan.phases.find(phase => phase.id === 'research')
assert.ok(researchPhase)
assert.equal(researchPhase.fanout, 4)
assert.equal(researchPhase.concurrency, 1)
assert.equal(researchPhase.review, 'none')
assert.equal(researchPhase.permissionMode, 'default')
assert.equal(researchPhase.agentType, 'researcher')
assert.equal(researchPhase.model, 'claude-sonnet-4-5')

const synthesisPhase = plan.phases.find(phase => phase.id === 'synthesis')
assert.ok(synthesisPhase)
assert.deepEqual(synthesisPhase.dependsOn, ['cross-check'])
assert.equal(synthesisPhase.fanout, 1)
assert.equal(synthesisPhase.concurrency, 1)
assert.equal(synthesisPhase.review, 'synthesis')
assert.equal(synthesisPhase.permissionMode, 'default')

const output = formatWorkflowDryRun(plan)
assert.match(output, /Workflow: Deep Research Dry Run/)
assert.match(output, /Description: Coordinate parallel research/)
assert.match(output, /Max concurrency: 4/)
assert.match(output, /Max agents: 32/)
assert.match(output, /Max retries: 0/)
assert.match(output, /Execution: agent/)
assert.match(output, /Planned agents: 7/)
assert.match(output, /- research \| depends: none \| fanout: 4 \| concurrency: 1 \| review: none \| permissionMode: default \| agentType: researcher \| model: claude-sonnet-4-5/)
assert.match(output, /- cross-check \| depends: research \| fanout: 2 \| concurrency: 2 \| review: cross-check \| permissionMode: default/)
assert.match(output, /- synthesis \| depends: cross-check \| fanout: 1 \| concurrency: 1 \| review: synthesis \| permissionMode: default/)

const trimmedDependencyPlan = validateWorkflowSpec({
  name: 'Trimmed Dependency',
  description: 'A workflow with whitespace around dependency ids.',
  phases: [
    {
      id: 'first',
      description: 'First phase.',
      prompt: 'Run the first phase.',
    },
    {
      id: 'second',
      description: 'Second phase.',
      prompt: 'Run the second phase.',
      dependsOn: [' first '],
    },
  ],
})
assert.deepEqual(trimmedDependencyPlan.phases[1]?.dependsOn, ['first'])

assert.throws(
  () => validateWorkflowSpec({
    name: 'Unknown Dependency',
    description: 'A workflow with a missing dependency.',
    phases: [
      {
        id: 'review',
        description: 'Review missing upstream work.',
        prompt: 'Review the missing phase output.',
        dependsOn: ['missing'],
      },
    ],
  }),
  /unknown dependency/i,
)

assert.throws(
  () => validateWorkflowSpec({
    name: 'Cycle',
    description: 'A workflow with a dependency cycle.',
    phases: [
      {
        id: 'alpha',
        description: 'Alpha phase.',
        prompt: 'Run alpha.',
        dependsOn: ['beta'],
      },
      {
        id: 'beta',
        description: 'Beta phase.',
        prompt: 'Run beta.',
        dependsOn: ['alpha'],
      },
    ],
  }),
  /cycle/i,
)

assert.throws(
  () => validateWorkflowSpec({
    name: 'Too Many Agents',
    description: 'A workflow that exceeds the maximum agent budget.',
    defaults: {
      maxAgents: 2,
    },
    phases: [
      {
        id: 'research',
        description: 'Research in too many branches.',
        prompt: 'Run too many research agents.',
        fanout: 3,
      },
    ],
  }),
  /maxAgents/i,
)

assert.throws(
  () => validateWorkflowSpec({
    name: 'Invalid Concurrency',
    description: 'A workflow phase with invalid concurrency.',
    phases: [
      {
        id: 'phase-one',
        description: 'A phase with too much concurrency.',
        prompt: 'Run with invalid concurrency.',
        fanout: 1,
        concurrency: 2,
      },
    ],
  }),
  /concurrency.*fanout/i,
)

assert.throws(
  () => validateWorkflowSpec({
    name: 'Global Concurrency Overflow',
    description: 'Independent root phases exceed the workflow concurrency budget together.',
    defaults: {
      maxConcurrency: 4,
    },
    phases: [
      {
        id: 'alpha',
        description: 'Run alpha workers.',
        prompt: 'Run alpha.',
        fanout: 4,
        concurrency: 4,
      },
      {
        id: 'beta',
        description: 'Run beta workers.',
        prompt: 'Run beta.',
        fanout: 4,
        concurrency: 4,
      },
    ],
  }),
  /global concurrency/i,
)

assert.throws(
  () => validateWorkflowSpec({
    name: 'Cross Level Concurrency Overflow',
    description: 'A downstream phase can overlap with a still-running independent root phase.',
    defaults: {
      maxConcurrency: 4,
    },
    phases: [
      {
        id: 'alpha',
        description: 'Short alpha phase.',
        prompt: 'Run alpha.',
        fanout: 1,
        concurrency: 1,
      },
      {
        id: 'beta',
        description: 'Long independent beta phase.',
        prompt: 'Run beta.',
        fanout: 3,
        concurrency: 3,
      },
      {
        id: 'gamma',
        description: 'Gamma can overlap with beta after alpha completes.',
        prompt: 'Run gamma.',
        dependsOn: ['alpha'],
        fanout: 3,
        concurrency: 3,
      },
    ],
  }),
  /global concurrency/i,
)

console.log('workflowSpec.test.ts passed')
