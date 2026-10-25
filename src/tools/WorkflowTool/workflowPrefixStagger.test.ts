import assert from 'node:assert/strict'

import {
  DEFAULT_WORKFLOW_PREFIX_STAGGER_MS,
  WORKFLOW_PREFIX_WARM_MS,
  WorkflowPrefixStagger,
  workflowPrefixStaggerCapMs,
  workflowPrefixStaggerKey,
} from './workflowPrefixStagger.js'

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
  let settled = false
  void promise.then(() => { settled = true })
  await new Promise<void>(resolve => setTimeout(resolve, ms))
  return settled
}

// Official 2.1.303 constants.
assert.equal(DEFAULT_WORKFLOW_PREFIX_STAGGER_MS, 5000)
assert.equal(WORKFLOW_PREFIX_WARM_MS, 270_000)

// Leader enters at once; a sibling waits until the leader's first response.
let clock = 1_000
const stagger = new WorkflowPrefixStagger(() => clock)
const leader = await stagger.enter('k', { capMs: 5000 })
assert.equal(leader.leader, true)
assert.equal(leader.waitedMs, 0)
assert.equal(stagger.stateOf('k'), 'warming')

const siblingEntry = stagger.enter('k', { capMs: 5000 })
assert.equal(await settledWithin(siblingEntry, 20), false)
clock += 300
leader.responded()
const sibling = await siblingEntry
assert.equal(sibling.leader, false)
assert.equal(sibling.waitedMs, 300)
assert.equal(stagger.stateOf('k'), 'warm')
leader.done()
assert.equal(stagger.stateOf('k'), 'warm')

// A warm prefix lets later entrants through without waiting, until it expires.
const warmEntrant = await stagger.enter('k', { capMs: 5000 })
assert.equal(warmEntrant.leader, false)
assert.equal(warmEntrant.waitedMs, 0)
clock += WORKFLOW_PREFIX_WARM_MS
assert.equal(stagger.stateOf('k'), 'cold')
const relead = await stagger.enter('k', { capMs: 5000 })
assert.equal(relead.leader, true)

// A leader that ends without responding releases its waiters and clears the entry.
const waiting = stagger.enter('k', { capMs: 5000 })
assert.equal(await settledWithin(waiting, 20), false)
clock += 40
relead.done()
assert.equal((await waiting).waitedMs, 40)
assert.equal(stagger.stateOf('k'), 'cold')

// The wait is capped at capMs, and capMs 0 means no wait at all.
const capStagger = new WorkflowPrefixStagger()
const capLeader = await capStagger.enter('k', { capMs: 30 })
const capSibling = await capStagger.enter('k', { capMs: 30 })
assert.ok(capSibling.waitedMs >= 25 && capSibling.waitedMs < 1000, `waited ${capSibling.waitedMs}ms`)
const noWait = await capStagger.enter('k', { capMs: 0 })
assert.equal(noWait.waitedMs, 0)
capLeader.done()

// An aborted signal ends the wait at once.
const abortStagger = new WorkflowPrefixStagger()
const abortLeader = await abortStagger.enter('k', { capMs: 5000 })
const controller = new AbortController()
const abortedEntry = abortStagger.enter('k', { capMs: 5000, signal: controller.signal })
await tick()
controller.abort()
assert.ok((await abortedEntry).waitedMs < 1000)
const preAborted = await abortStagger.enter('k', { capMs: 5000, signal: AbortSignal.abort() })
assert.equal(preAborted.waitedMs, 0)
abortLeader.done()

// Different keys do not wait on each other; clear() releases everyone.
const keyStagger = new WorkflowPrefixStagger()
await keyStagger.enter('a', { capMs: 5000 })
const other = await keyStagger.enter('b', { capMs: 5000 })
assert.equal(other.leader, true)
const cleared = keyStagger.enter('a', { capMs: 5000 })
keyStagger.clear()
await cleared
assert.equal(keyStagger.stateOf('a'), 'cold')
assert.equal(keyStagger.stateOf('b'), 'cold')

// The key is the official newline-joined prefix tuple.
assert.equal(
  workflowPrefixStaggerKey({
    model: 'claude-sonnet-4-6', effort: 'low', agentType: undefined,
    toolNames: ['Read', 'Bash'], schema: { type: 'object' }, cwd: '/repo',
  }),
  'claude-sonnet-4-6\nlow\n\nRead,Bash\n{"type":"object"}\n/repo',
)
assert.equal(
  workflowPrefixStaggerKey({ model: undefined, effort: undefined, agentType: 'reviewer', toolNames: [], schema: undefined, cwd: '/repo' }),
  '\n\nreviewer\n\n\n/repo',
)

// Cap: env override, DISABLE_PROMPT_CACHING turns it off, garbage falls back to the default.
const savedCap = process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS
const savedCaching = process.env.DISABLE_PROMPT_CACHING
try {
  delete process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS
  delete process.env.DISABLE_PROMPT_CACHING
  assert.equal(workflowPrefixStaggerCapMs(), 5000)
  process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS = '250'
  assert.equal(workflowPrefixStaggerCapMs(), 250)
  process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS = '0'
  assert.equal(workflowPrefixStaggerCapMs(), 0)
  process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS = 'soon'
  assert.equal(workflowPrefixStaggerCapMs(), 5000)
  process.env.DISABLE_PROMPT_CACHING = '1'
  process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS = '250'
  assert.equal(workflowPrefixStaggerCapMs(), 0)
} finally {
  if (savedCap === undefined) delete process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS
  else process.env.CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS = savedCap
  if (savedCaching === undefined) delete process.env.DISABLE_PROMPT_CACHING
  else process.env.DISABLE_PROMPT_CACHING = savedCaching
}

console.log('workflowPrefixStagger.test.ts passed')
