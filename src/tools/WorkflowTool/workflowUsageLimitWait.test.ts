import assert from 'node:assert/strict'

import type { ClaudeAILimits } from '../../services/claudeAiLimits.js'
import {
  MAX_EXPIRED_RESET_WAITS,
  MAX_FUTURE_RESET_WAITS,
  USAGE_LIMIT_MAX_WAIT_MS,
  USAGE_LIMIT_POLL_MS,
  WorkflowUsageLimitWait,
  type WorkflowUsageLimitWaitStatus,
  formatUsageLimitResets,
  isUsageLimitRejection,
  usageLimitPausedText,
} from './workflowUsageLimitWait.js'

// Official 2.1.303 constants.
assert.equal(MAX_FUTURE_RESET_WAITS, 2)
assert.equal(MAX_EXPIRED_RESET_WAITS, 2)
assert.equal(USAGE_LIMIT_POLL_MS, 30_000)
assert.equal(USAGE_LIMIT_MAX_WAIT_MS, 86_400_000)

const nowSeconds = () => Math.floor(Date.now() / 1000)
const rejected = (resetsAt: number | undefined, extra: Partial<ClaudeAILimits> = {}): ClaudeAILimits => ({
  status: 'rejected',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
  resetsAt,
  ...extra,
})

assert.equal(isUsageLimitRejection(rejected(nowSeconds() + 60)), true)
assert.equal(isUsageLimitRejection(rejected(undefined)), false)
assert.equal(isUsageLimitRejection(rejected(Infinity)), false)
assert.equal(isUsageLimitRejection(rejected(nowSeconds() + 60, { isUsingOverage: true })), false)
assert.equal(isUsageLimitRejection(rejected(nowSeconds() + 60, { status: 'allowed_warning' })), false)

assert.match(formatUsageLimitResets(nowSeconds() + 3600)!, /^resets at \d/)
assert.match(formatUsageLimitResets(nowSeconds() + 3 * 86_400)!, /^resets [A-Z]/)
assert.equal(formatUsageLimitResets(undefined), undefined)
assert.match(usageLimitPausedText(nowSeconds() + 3600), /^Paused · usage limit resets at \d/)
assert.equal(usageLimitPausedText(undefined), 'Paused · usage limit')

function createWait(options: {
  enabled?: () => boolean
  signal?: AbortSignal
  jitterMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
} = {}) {
  const logs: string[] = []
  const changes: Array<WorkflowUsageLimitWaitStatus | undefined> = []
  const wait = new WorkflowUsageLimitWait({
    signal: options.signal,
    log: message => logs.push(message),
    onChange: status => changes.push(status),
    isEnabled: options.enabled ?? (() => true),
    resumeJitterMs: () => options.jitterMs ?? 0,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  })
  return { wait, logs, changes }
}

// Declined without a failure note when the limits are not a usage-limit rejection or waiting is off.
{
  const { wait, logs } = createWait()
  assert.deepEqual(wait.join(undefined), { outcome: 'declined', failureNote: undefined })
  assert.deepEqual(wait.join(rejected(nowSeconds() + 1, { isUsingOverage: true })), { outcome: 'declined', failureNote: undefined })
  assert.deepEqual(logs, [])
}
{
  const { wait } = createWait({ enabled: () => false })
  assert.deepEqual(wait.join(rejected(nowSeconds() + 1)), { outcome: 'declined', failureNote: undefined })
}

// Aborted run.
{
  const controller = new AbortController()
  controller.abort()
  const { wait } = createWait({ signal: controller.signal })
  assert.deepEqual(wait.join(rejected(nowSeconds() + 1)), { outcome: 'aborted' })
}

// A reset more than a day out is not waited for.
{
  const { wait } = createWait()
  const far = nowSeconds() + 2 * 86_400
  const joined = wait.join(rejected(far))
  assert.equal(joined.outcome, 'declined')
  assert.equal(
    joined.outcome === 'declined' && joined.failureNote,
    `usage limit; resets ${formatUsageLimitResets(far, true)!.replace(/^resets /, '')}, too far out to wait for`,
  )
}

// One wait at a time: later agents join it, then all resume after the reset.
{
  const { wait, logs, changes } = createWait()
  const resetsAt = nowSeconds()
  const first = wait.join(rejected(resetsAt))
  assert.equal(first.outcome, 'waiting')
  assert.match(logs[0]!, /^Usage limit reached · resets at .+\. Workflow paused; waiting agents re-run shortly after the reset\.$/)
  assert.equal(changes.at(-1)?.waitingAgents, 1)
  let cleared = false
  const clear = wait.whenClear().then(() => { cleared = true })
  const second = wait.join(rejected(resetsAt + 1))
  assert.equal(second.outcome, 'waiting')
  assert.equal(changes.at(-1)?.waitingAgents, 2)
  assert.equal(changes.at(-1)?.resetsAt, resetsAt + 1)
  assert.equal(logs.length, 1)
  assert.equal(cleared, false)
  assert.equal(first.outcome === 'waiting' && await first.ended, 'resumed')
  assert.equal(second.outcome === 'waiting' && await second.ended, 'resumed')
  await clear
  assert.equal(cleared, true)
  assert.equal(changes.at(-1), undefined)
  assert.equal(logs.at(-1), 'Usage limit reset. Re-running 2 waiting agents.')
}

// Expired resets are counted separately and capped.
{
  const { wait, logs } = createWait()
  const past = nowSeconds() - 10
  for (let i = 0; i < MAX_EXPIRED_RESET_WAITS; i++) {
    const joined = wait.join(rejected(past))
    assert.equal(joined.outcome === 'waiting' && await joined.ended, 'resumed')
  }
  const capped = wait.join(rejected(past))
  assert.equal(capped.outcome, 'declined')
  assert.match(
    capped.outcome === 'declined' ? capped.failureNote! : '',
    /^usage limit; resets .+, and this run already waited for 2 resets$/,
  )
  assert.equal(logs.at(-1), 'Usage limit reset. Re-running 1 waiting agent.')
}

// Turning the setting off while waiting revokes the wait at the next poll.
{
  let enabled = true
  const polls: number[] = []
  const { wait, logs, changes } = createWait({
    enabled: () => enabled,
    jitterMs: 60_000,
    sleep: async ms => {
      polls.push(ms)
      enabled = false
    },
  })
  const joined = wait.join(rejected(nowSeconds()))
  assert.equal(joined.outcome === 'waiting' && await joined.ended, 'revoked')
  assert.deepEqual(polls, [USAGE_LIMIT_POLL_MS])
  assert.equal(
    logs.at(-1),
    'Waiting for usage limits to reset was turned off. 1 waiting agent will not run again.',
  )
  assert.equal(changes.at(-1), undefined)
}

// Aborting the run ends the wait.
{
  const controller = new AbortController()
  const { wait } = createWait({ signal: controller.signal, jitterMs: 60_000 })
  const joined = wait.join(rejected(nowSeconds()))
  controller.abort()
  assert.equal(joined.outcome === 'waiting' && await joined.ended, 'aborted')
}

console.log('workflowUsageLimitWait tests passed')
