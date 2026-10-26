import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hasWorkflowScriptMeta } from '../workflowScriptParser.js'
import { getBundledWorkflowSpecs } from './index.js'

const bundledWorkflows = getBundledWorkflowSpecs()
// Official bundles only deep-research; its /code-review is a skill, not a workflow.
assert.deepEqual(bundledWorkflows.map(workflow => workflow.name), ['deep-research'])

const deepResearch = bundledWorkflows.find(workflow => workflow.name === 'deep-research')
assert.ok(deepResearch)
// Official 2.1.303/2.1.310 bundle the same deep-research script byte for byte.
const officialScript = readFileSync(new URL('./deepResearch.workflow.txt', import.meta.url), 'utf8')
assert.equal(deepResearch.runScriptSnapshot, officialScript)
assert.ok(hasWorkflowScriptMeta(deepResearch.runScriptSnapshot ?? ''))
assert.equal(createHash('sha256').update(officialScript).digest('hex').slice(0, 16), '9e4a49882edec851')
assert.equal(
  deepResearch.description,
  'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
)
assert.match(deepResearch.meta?.whenToUse ?? '', /^When the user wants a deep, multi-source, fact-checked research report on any topic\. BEFORE invoking/)
assert.deepEqual(
  deepResearch.phases.map(phase => phase.id),
  ['Scope', 'Search', 'Fetch', 'Verify', 'Synthesize'],
)
assert.equal(deepResearch.requiresInput, undefined)
// GrowthBook is off in the fork, so tengu_sorrel_avocet keeps its default (false) like official.
assert.equal(deepResearch.disableModelInvocation, true)

console.log('bundled/index.test.ts passed')
