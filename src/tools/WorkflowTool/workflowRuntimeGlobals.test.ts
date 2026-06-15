import assert from 'node:assert/strict'

import { createWorkflowRuntimeGlobals } from './workflowRuntimeGlobals.js'

const logs: string[] = []
const globals = createWorkflowRuntimeGlobals({
  args: { topic: 'workflow runtime' },
  workflowRunId: 'wf_runtime',
  budgetTotal: 10,
  log: message => logs.push(message),
})

assert.deepEqual(globals.args, { topic: 'workflow runtime' })
assert.equal(globals.budget.total, 10)
assert.equal(globals.budget.spent(), 0)
assert.equal(globals.budget.remaining(), 10)

globals.phase('Scan')
globals.log('started')
assert.deepEqual(logs, ['started'])

const first = await globals.agent('Find files', {
  label: 'scan',
  schema: {
    type: 'object',
    required: ['angles'],
    properties: {
      angles: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          required: ['label', 'prompt'],
          properties: {
            label: { type: 'string' },
            prompt: { type: 'string' },
          },
        },
      },
    },
  },
})
assert.deepEqual(first, {
  angles: [
    {
      label: '{{agent:scan.angles[0].label}}',
      prompt: '{{agent:scan.angles[0].prompt}}',
    },
  ],
})

const parallel = await globals.parallel([
  () => globals.agent('A', { label: 'a' }),
  () => globals.agent('B', { label: 'b' }),
])
assert.deepEqual(parallel.map(item => item && item.label), ['a', 'b'])

const pipeline = await globals.pipeline(
  ['one', 'two'],
  item => globals.agent(`stage1 ${item}`, { label: `stage1-${item}` }),
  (prior, original) => globals.agent(`stage2 ${prior?.label} ${original}`, { label: `stage2-${original}` }),
)
assert.deepEqual(pipeline.map(item => item && item.label), ['stage2-one', 'stage2-two'])

assert.throws(() => globals.Date.now(), /Date\.now\(\) \/ new Date\(\) are unavailable/)
assert.throws(() => globals.Math.random(), /Math\.random\(\) is unavailable/)
assert.equal(globals.Math.max(1, 3, 2), 3)

const spec = globals.toWorkflowSpec({
  name: 'official-runtime',
  description: 'Official runtime adapter',
})
assert.equal(spec.name, 'official-runtime')
assert.deepEqual(spec.phases.map(phase => phase.id), [
  'scan',
  'a',
  'b',
  'stage1-one',
  'stage2-one',
  'stage1-two',
  'stage2-two',
])
assert.equal(spec.phases[0]?.description, 'scan')
assert.equal(spec.phases[0]?.prompt, 'Find files')

const modeGlobals = createWorkflowRuntimeGlobals({
  workflowRunId: 'wf_modes',
})
await modeGlobals.agent('Plan prompt', { label: 'plan-agent', mode: 'plan' })
modeGlobals.phase('Grouped')
await modeGlobals.agent('Default grouped prompt', { label: 'default-agent', phase: 'Grouped', mode: 'default' })
const modeSpec = modeGlobals.toWorkflowSpec({
  name: 'mode-spec',
  description: 'Mode spec workflow',
})
assert.equal(modeSpec.phases[0]?.permissionMode, 'plan')
assert.equal(modeSpec.phases[1]?.permissionMode, 'default')

const phaseOnlyGlobals = createWorkflowRuntimeGlobals({
  workflowRunId: 'wf_phase_only',
})
phaseOnlyGlobals.phase('Smoke')
const phaseOnlySpec = phaseOnlyGlobals.toWorkflowSpec({
  name: 'phase-only',
  description: 'Phase-only workflow',
})
assert.deepEqual(phaseOnlySpec.phases, [
  {
    id: 'Smoke',
    description: 'Smoke',
    prompt: 'Run workflow phase: Smoke',
    fanout: 0,
  },
])

console.log('workflowRuntimeGlobals.test.ts passed')
