#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendWorkflowJournalFailed,
  appendWorkflowJournalLaunched,
  appendWorkflowJournalResult,
  appendWorkflowJournalStarted,
  readWorkflowJournalCacheEntries,
  readWorkflowJournalEntries,
  workflowJournalPath,
} from './workflowJournal.js'

const dir = await mkdtemp(join(tmpdir(), 'workflow-journal-test-'))
const startedAt = 1710000000000
const completedAt = 1710000000100

await appendWorkflowJournalLaunched(dir)
await appendWorkflowJournalStarted(dir, {
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  timestamp: startedAt,
})
await appendWorkflowJournalResult(dir, {
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  attempt: 0,
  result: 'agent output',
  timestamp: completedAt,
})
await appendWorkflowJournalFailed(dir, {
  key: 'phase-a:agent-b:1',
  agentId: 'agent-b',
  phase: 'phase-a',
  label: 'agent-b',
  index: 1,
  status: 'failed',
  attempt: 0,
  error: 'API Error: test failure',
  tokenCount: 42,
  toolUseCount: 3,
  durationMs: 9,
  timestamp: completedAt + 1,
})

const raw = await readFile(workflowJournalPath(dir), 'utf8')
const lines = raw.trim().split('\n').map(line => JSON.parse(line))
assert.deepEqual(lines[0], { type: 'launched' })
assert.deepEqual(lines[1], {
  type: 'started',
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  timestamp: startedAt,
})
assert.deepEqual(lines[2], {
  type: 'result',
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  attempt: 0,
  result: 'agent output',
  timestamp: completedAt,
})
// Like official, a failure is its own line type, never a `result` (official would replay it).
assert.deepEqual(lines[3], {
  type: 'failed',
  key: 'phase-a:agent-b:1',
  agentId: 'agent-b',
  phase: 'phase-a',
  label: 'agent-b',
  index: 1,
  status: 'failed',
  attempt: 0,
  error: 'API Error: test failure',
  tokenCount: 42,
  toolUseCount: 3,
  durationMs: 9,
  timestamp: completedAt + 1,
})

// Lines written by official 2.1.303: result lines carry no status or timestamp, failed lines
// only the key, and restore markers are skipped.
await appendFile(workflowJournalPath(dir), [
  JSON.stringify({ type: 'restoring' }),
  JSON.stringify({ type: 'result', key: 'v2:official', agentId: 'a3ea71d78e1992484', result: 'A1' }),
  JSON.stringify({ type: 'failed', key: 'v2:official-failed', agentId: 'ac175219d3611d969' }),
  JSON.stringify({ type: 'restored' }),
  '',
].join('\n'))

const cache = await readWorkflowJournalCacheEntries(dir)
assert.deepEqual(cache, [
  {
    index: 0,
    identity: 'phase-a:agent-a:0',
    phase: 'phase-a',
    label: 'agent-a',
    result: 'agent output',
    completedAt,
  },
  {
    index: 5,
    identity: 'v2:official',
    phase: undefined,
    label: undefined,
    result: 'A1',
    completedAt: 0,
  },
])
assert.deepEqual(
  (await readWorkflowJournalEntries(dir)).map(entry => entry.type),
  ['launched', 'started', 'result', 'failed', 'restoring', 'result', 'failed', 'restored'],
)

console.log('workflowJournal.test.ts passed')
