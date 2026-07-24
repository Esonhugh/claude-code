import assert from 'node:assert/strict'
import { getBundledWorkflowSpecs } from './index.js'

const bundledWorkflows = getBundledWorkflowSpecs()
assert.deepEqual(
  bundledWorkflows.map(workflow => workflow.name).sort(),
  ['code-review', 'deep-research'],
)

const codeReview = bundledWorkflows.find(workflow => workflow.name === 'code-review')
assert.ok(codeReview)
assert.deepEqual(
  codeReview.phases.map(phase => phase.displayName ?? phase.id),
  ['Scope', 'Find', 'Verify', 'Sweep', 'Synthesize'],
)
assert.equal(
  codeReview.description,
  'Workflow-backed code review — one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.',
)
assert.match(codeReview.meta?.whenToUse ?? '', /high, xhigh, or max/)
assert.match(codeReview.runScriptSnapshot ?? '', /const LEVEL_PARAMS/)
assert.match(codeReview.runScriptSnapshot ?? '', /MAX_VERIFY = 25/)
assert.match(codeReview.runScriptSnapshot ?? '', /phase\("Synthesize"\)/)
assert.match(
  codeReview.runScriptSnapshot ?? '',
  /Array\.isArray\(report\?\.findings\)/,
)
assert.equal(codeReview.defaults?.permissionMode, 'plan')

const deepResearch = bundledWorkflows.find(workflow => workflow.name === 'deep-research')
assert.ok(deepResearch)
assert.equal(deepResearch.defaults?.maxRetries, 0)

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
const searchPhase = deepResearch.phases.find(phase => phase.id === 'search')
assert.match(searchPhase?.prompt ?? '', /top 4-6 most relevant results/)
assert.equal(searchPhase?.agentPrompts?.length, 5)
for (const [index, prompt] of searchPhase?.agentPrompts?.entries() ?? []) {
  assert.match(prompt, new RegExp(`scoped angle ${index + 1}`))
  assert.match(prompt, /Use WebSearch exactly once/)
  assert.match(prompt, /ToolSearch at most once with query select:WebSearch/)
  assert.match(prompt, /Do not search any other angle, call any other tool, or delegate/)
}

const fetchPhase = deepResearch.phases.find(phase => phase.id === 'fetch')
const fetchPrompt = fetchPhase?.prompt ?? ''
assert.match(fetchPrompt, /sourceQuality: "unreliable"/)
assert.match(fetchPrompt, /fetch exactly one source/i)
assert.match(fetchPrompt, /one-based worker number/)
assert.match(fetchPrompt, /ToolSearch at most once with query select:WebFetch/)
assert.match(fetchPrompt, /Use WebFetch exactly once/)
assert.match(fetchPrompt, /even when that source is unavailable, blocked, irrelevant, or paywalled/)
assert.match(fetchPrompt, /report the failure instead of retrying or substituting another source/)
assert.match(fetchPrompt, /Do not fetch any other source, call any other tool, or delegate/)
assert.match(fetchPrompt, /Return selectedSource with oneBasedRank and URL/)
assert.match(fetchPrompt, /exactly one JSON object with no Markdown fence/)
assert.equal(fetchPhase?.agentPrompts?.length, 15)
for (const [index, prompt] of fetchPhase?.agentPrompts?.entries() ?? []) {
  assert.match(prompt, new RegExp(`source ${index + 1}`))
  assert.match(prompt, /shared deterministic source list/)
  assert.match(prompt, /flatten workers in scoped-angle order/)
  assert.match(prompt, /preserve each worker's result order/)
  assert.match(prompt, /normalized exact URL \(preserving scheme and query while ignoring fragments\)/)
  assert.match(prompt, /Do not independently re-rank the sources/)
  assert.match(prompt, /ToolSearch at most once with query select:WebFetch/)
  assert.match(prompt, /using WebFetch exactly once/)
  assert.match(prompt, /even when the source is unavailable, blocked, irrelevant, or paywalled/)
  assert.match(prompt, /Report a failed fetch instead of retrying or substituting another source/)
  assert.match(prompt, /Do not fetch any other source, call any other tool, or delegate/)
  assert.match(
    prompt,
    new RegExp(`selectedSource: \\{ oneBasedRank: ${index + 1}, url:`),
  )
  assert.match(prompt, /exactly one JSON object with no Markdown fence/)
}

const verifyPhase = deepResearch.phases.find(phase => phase.id === 'verify')
const verifyPrompt = verifyPhase?.prompt ?? ''
assert.match(verifyPrompt, /one of three independent verifier votes/)
assert.match(verifyPrompt, /Do not call tools or delegate/)
assert.match(verifyPrompt, /Default to refuted=true if uncertain/)
assert.equal(verifyPhase?.permissionMode, 'dontAsk')
assert.equal(verifyPhase?.agentPrompts?.length, 3)
for (const [index, prompt] of verifyPhase?.agentPrompts?.entries() ?? []) {
  assert.match(prompt, new RegExp(`verifier vote ${index + 1} of 3`))
  assert.match(prompt, /Produce exactly one independent vote per claim/)
  assert.match(prompt, /do not call tools or delegate/)
}

const synthesizePhase = deepResearch.phases.find(phase => phase.id === 'synthesize')
const synthesizePrompt = synthesizePhase?.prompt ?? ''
assert.match(synthesizePrompt, /Use only the upstream verification outputs/)
assert.match(synthesizePrompt, /do not call tools or delegate/)
assert.match(synthesizePrompt, /Synthesis step was skipped or failed/)
assert.equal(synthesizePhase?.permissionMode, 'dontAsk')

console.log('bundled/index.test.ts passed')
