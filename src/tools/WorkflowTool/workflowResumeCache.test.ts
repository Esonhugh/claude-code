import assert from 'node:assert/strict'

import {
  createAgentCallIdentity,
  createWorkflowScriptAgentChainIdentity,
  createWorkflowResumeCursor,
  recordResumeCacheEntry,
  type WorkflowResumeCacheEntry,
} from './workflowResumeCache.js'

const firstIdentity = createAgentCallIdentity({
  index: 0,
  phase: 'Scan',
  prompt: 'Find files',
  opts: { label: 'scan', schema: { type: 'object' } },
})
const secondIdentity = createAgentCallIdentity({
  index: 1,
  phase: 'Verify',
  prompt: 'Verify files',
  opts: { label: 'verify' },
})

const priorEntries: WorkflowResumeCacheEntry[] = [
  recordResumeCacheEntry({
    index: 0,
    identity: firstIdentity,
    phase: 'Scan',
    label: 'scan',
    result: { files: ['a.ts'] },
  }),
  recordResumeCacheEntry({
    index: 1,
    identity: secondIdentity,
    phase: 'Verify',
    label: 'verify',
    result: 'verified',
  }),
]

const cursor = createWorkflowResumeCursor(priorEntries)
assert.deepEqual(cursor.lookup(0, firstIdentity), {
  cacheHit: true,
  result: { files: ['a.ts'] },
})
assert.deepEqual(cursor.lookup(1, secondIdentity), {
  cacheHit: true,
  result: 'verified',
})

const changedIdentity = createAgentCallIdentity({
  index: 2,
  phase: 'Synthesize',
  prompt: 'Synthesize changed prompt',
  opts: { label: 'synthesize' },
})
assert.deepEqual(cursor.lookup(2, changedIdentity), { cacheHit: false })
assert.deepEqual(cursor.lookup(0, firstIdentity), { cacheHit: false })

const insertedStepCursor = createWorkflowResumeCursor(priorEntries)
const insertedIdentity = createAgentCallIdentity({
  index: 0,
  phase: 'Prep',
  prompt: 'Prep work',
  opts: { label: 'prep' },
})
assert.deepEqual(insertedStepCursor.lookup(0, insertedIdentity), { cacheHit: false })
assert.deepEqual(insertedStepCursor.lookup(1, firstIdentity), {
  cacheHit: true,
  result: { files: ['a.ts'] },
})

assert.notEqual(
  createAgentCallIdentity({ index: 0, phase: 'Scan', prompt: 'Find files', opts: { label: 'scan' } }),
  createAgentCallIdentity({ index: 0, phase: 'Scan', prompt: 'Find changed files', opts: { label: 'scan' } }),
)
// Like official 2.1.292, label and phase are display-only: changing them replays the cache.
assert.equal(
  createWorkflowScriptAgentChainIdentity({ previousKey: '', prompt: 'same prompt' }),
  createWorkflowScriptAgentChainIdentity({ previousKey: '', prompt: 'same prompt', opts: {} }),
)
assert.notEqual(
  createWorkflowScriptAgentChainIdentity({ previousKey: '', prompt: 'same prompt' }),
  createWorkflowScriptAgentChainIdentity({ previousKey: '', prompt: 'same prompt', opts: { model: 'opus' } }),
)
assert.notEqual(
  createWorkflowScriptAgentChainIdentity({
    previousKey: '',
    prompt: 'same prompt',
    opts: { mode: 'bypassPermissions' },
  }),
  createWorkflowScriptAgentChainIdentity({
    previousKey: '',
    prompt: 'same prompt',
    opts: { mode: 'plan' },
  }),
)

// Keys recorded by official 2.1.303 (lifecycle probe journal): the chain runs in call order
// and only the keyed options matter.
const officialA1 = createWorkflowScriptAgentChainIdentity({
  previousKey: '',
  prompt: 'Return exactly the token A1',
  opts: { label: 'fan-A1' },
})
assert.equal(officialA1, 'v2:aae2e31964d4870d508f9b4f4537f58cd803e046a9e0191fe77b1a89dc2fea3f')
assert.equal(
  createWorkflowScriptAgentChainIdentity({
    previousKey: officialA1,
    prompt: 'Return exactly the token A2',
    opts: { label: 'fan-A2', stallMs: 1000, phase: 'Fan' },
  }),
  'v2:2b88aab68770fe5ea0da01a24c12c4295d879c614f7861c49480b54daa5984e2',
)
assert.equal(
  createWorkflowScriptAgentChainIdentity({
    previousKey: 'v2:8daa37fbd0872e54fcb5b4aecf519623638dc7656eed5dec7ad57fb929ede227',
    prompt: 'Summarize the run. Return ok and the agent count.',
    opts: {
      label: 'final',
      schema: { type: 'object', required: ['ok', 'count'], properties: { ok: { type: 'boolean' }, count: { type: 'number' } }, additionalProperties: false },
    },
  }),
  'v2:84d7e5936f12ac641699398df2c8bef82b7a0b2e0092460733ac859c91183f57',
)
assert.equal(
  createWorkflowScriptAgentChainIdentity({ previousKey: '', prompt: 'same prompt', opts: { mode: 'default' } }),
  createWorkflowScriptAgentChainIdentity({ previousKey: '', prompt: 'same prompt' }),
)

console.log('workflowResumeCache.test.ts passed')
