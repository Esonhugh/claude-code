import assert from 'node:assert/strict'
import { getBundledWorkflowSpecs } from './index.js'

const deepResearch = getBundledWorkflowSpecs().find(
  workflow => workflow.name === 'deep-research',
)
assert.ok(deepResearch)

assert.deepEqual(
  deepResearch.phases.map(phase => phase.id),
  ['scope', 'search', 'fetch', 'verify', 'synthesize'],
)
assert.equal(deepResearch.phases.find(phase => phase.id === 'scope')?.fanout, undefined)
assert.equal(deepResearch.phases.find(phase => phase.id === 'search')?.fanout, 5)
assert.equal(deepResearch.phases.find(phase => phase.id === 'fetch')?.fanout, 15)
assert.equal(deepResearch.phases.find(phase => phase.id === 'verify')?.fanout, 3)
assert.equal(
  deepResearch.description,
  'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
)
assert.equal(
  deepResearch.meta?.whenToUse,
  'When the user wants a deep, multi-source, fact-checked research report on any topic.',
)
assert.match(
  deepResearch.runScriptSnapshot ?? '',
  /REPORT_SCHEMA/,
)
assert.match(
  deepResearch.runScriptSnapshot ?? '',
  /VOTES_PER_CLAIM = 3/,
)
assert.match(
  deepResearch.runScriptSnapshot ?? '',
  /REFUTATIONS_REQUIRED = 2/,
)
assert.match(
  deepResearch.runScriptSnapshot ?? '',
  /MAX_FETCH = 15/,
)
assert.match(
  deepResearch.runScriptSnapshot ?? '',
  /MAX_VERIFY_CLAIMS = 25/,
)
assert.match(
  deepResearch.runScriptSnapshot ?? '',
  /stats: \{ sourcesFetched, claimsVerified, claimsRefuted, claimsUsed \}/,
)
assert.match(
  deepResearch.phases.find(phase => phase.id === 'scope')?.prompt ?? '',
  /Structured output only/,
)
assert.match(
  deepResearch.phases.find(phase => phase.id === 'search')?.prompt ?? '',
  /top 4-6 most relevant results/,
)
assert.match(
  deepResearch.phases.find(phase => phase.id === 'fetch')?.prompt ?? '',
  /sourceQuality: "unreliable"/,
)
assert.match(
  deepResearch.phases.find(phase => phase.id === 'verify')?.prompt ?? '',
  /Default to refuted=true if uncertain/,
)
assert.match(
  deepResearch.phases.find(phase => phase.id === 'synthesize')?.prompt ?? '',
  /Synthesis step was skipped or failed/,
)

console.log('bundled/index.test.ts passed')
