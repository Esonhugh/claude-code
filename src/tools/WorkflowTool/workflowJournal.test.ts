#!/usr/bin/env node
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendWorkflowJournalResult,
  appendWorkflowJournalStarted,
  readWorkflowJournalCacheEntries,
  workflowJournalPath,
} from './workflowJournal.js'

const dir = await mkdtemp(join(tmpdir(), 'workflow-journal-test-'))
const startedAt = 1710000000000
const completedAt = 1710000000100

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
  status: 'completed',
  attempt: 0,
  result: 'agent output',
  timestamp: completedAt,
})
await appendWorkflowJournalResult(dir, {
  key: 'phase-a:agent-b:1',
  agentId: 'agent-b',
  phase: 'phase-a',
  label: 'agent-b',
  index: 1,
  status: 'failed',
  attempt: 0,
  error: 'API Error: test failure',
  result: null,
  timestamp: completedAt + 1,
})

const raw = await readFile(workflowJournalPath(dir), 'utf8')
const lines = raw.trim().split('\n').map(line => JSON.parse(line))
assert.deepEqual(lines[0], {
  type: 'started',
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  timestamp: startedAt,
})
assert.deepEqual(lines[1], {
  type: 'result',
  key: 'phase-a:agent-a:0',
  agentId: 'agent-a',
  phase: 'phase-a',
  label: 'agent-a',
  index: 0,
  status: 'completed',
  attempt: 0,
  result: 'agent output',
  timestamp: completedAt,
})
assert.deepEqual(lines[2], {
  type: 'result',
  key: 'phase-a:agent-b:1',
  agentId: 'agent-b',
  phase: 'phase-a',
  label: 'agent-b',
  index: 1,
  status: 'failed',
  attempt: 0,
  error: 'API Error: test failure',
  result: null,
  timestamp: completedAt + 1,
})

await appendFile(workflowJournalPath(dir), `${JSON.stringify({
  type: 'result',
  key: 'legacy-statusless',
  agentId: 'legacy-statusless',
  result: 'must not resume',
  timestamp: completedAt + 2,
})}\n`)

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
])

console.log('workflowJournal.test.ts passed')
