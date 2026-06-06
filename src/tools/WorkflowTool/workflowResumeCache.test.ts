import assert from 'node:assert/strict'

import {
  createAgentCallIdentity,
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

assert.notEqual(
  createAgentCallIdentity({ index: 0, phase: 'Scan', prompt: 'Find files', opts: { label: 'scan' } }),
  createAgentCallIdentity({ index: 0, phase: 'Scan', prompt: 'Find changed files', opts: { label: 'scan' } }),
)

console.log('workflowResumeCache.test.ts passed')
