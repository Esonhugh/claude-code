import assert from 'node:assert/strict'
import { test } from 'bun:test'

import {
  buildMonitorEventNotification,
  createMonitorEventStream,
} from './monitorEvents.js'

function harness(options: { killResult?: boolean } = {}) {
  let clock = 0
  const timers: Array<() => void> = []
  const notifications: string[] = []
  let kills = 0
  const stream = createMonitorEventStream({
    taskRef: { id: 'b1' },
    description: 'errors in app.log',
    killTask: () => {
      kills++
      return options.killResult ?? true
    },
    now: () => clock,
    schedule: fn => {
      timers.push(fn)
      return () => {
        const index = timers.indexOf(fn)
        if (index !== -1) timers.splice(index, 1)
      }
    },
    notify: value => notifications.push(value),
  })
  return {
    stream,
    notifications,
    advance(ms: number) {
      clock += ms
    },
    fireTimers() {
      for (const fn of timers.splice(0)) fn()
    },
    pendingTimers: () => timers.length,
    kills: () => kills,
  }
}

function eventBody(notification: string): string {
  return /<event>([\s\S]*)<\/event>/.exec(notification)?.[1] ?? ''
}

test('event notification carries task id, summary and escaped event body', () => {
  assert.equal(
    buildMonitorEventNotification('b1', 'deploy <prod>', 'a & b'),
    `<task-notification>
<task-id>b1</task-id>
<summary>Monitor event: "deploy &lt;prod&gt;"</summary>
<event>a &amp; b</event>
</task-notification>`,
  )
})

test('lines arriving within the batch window become one event', () => {
  const h = harness()
  h.stream.onData('ERROR one\nERROR ')
  h.stream.onData('two\n')
  assert.equal(h.notifications.length, 0)
  assert.equal(h.pendingTimers(), 1)
  h.fireTimers()
  assert.equal(h.notifications.length, 1)
  assert.equal(eventBody(h.notifications[0]!), 'ERROR one\nERROR two')
  assert.equal(h.stream.eventCount(), 1)
})

test('partial trailing line is held until a final flush, blank lines are dropped', () => {
  const h = harness()
  h.stream.onData('\n\n   \nno newline yet')
  assert.equal(h.pendingTimers(), 0)
  h.stream.flush()
  assert.equal(h.notifications.length, 0)
  h.stream.flush(true)
  assert.equal(eventBody(h.notifications[0]!), 'no newline yet')
})

test('long lines and large batches are truncated', () => {
  const h = harness()
  h.stream.onData('x'.repeat(600) + '\n')
  h.fireTimers()
  assert.equal(eventBody(h.notifications[0]!), 'x'.repeat(500) + '...(truncated)')

  for (let i = 0; i < 10; i++) h.stream.onData('y'.repeat(400) + '\n')
  h.fireTimers()
  const body = eventBody(h.notifications[1]!)
  assert.ok(body.endsWith('\n...(truncated)'))
  assert.equal(body.length, 3000 + '\n...(truncated)'.length)
})

test('events beyond the token bucket are suppressed and reported once tokens refill', () => {
  const h = harness()
  for (let i = 0; i < 12; i++) {
    h.stream.onData(`line ${i}\n`)
    h.fireTimers()
  }
  assert.equal(h.notifications.length, 10)
  assert.equal(h.stream.eventCount(), 10)

  h.advance(2000)
  h.stream.onData('after refill\n')
  h.fireTimers()
  assert.equal(h.notifications.length, 12)
  assert.match(h.notifications[10]!, /\[2 events suppressed — output rate too high/)
  assert.equal(eventBody(h.notifications[11]!), 'after refill')
})

test('a monitor still flooding after 30s of suppression is stopped', () => {
  const h = harness()
  // One batch per second outpaces the refill (one token per 2s), so after
  // the initial burst every other event is suppressed without a 6s gap.
  for (let i = 0; i < 60 && h.kills() === 0; i++) {
    h.advance(1000)
    h.stream.onData(`flood ${i}\n`)
    h.fireTimers()
  }
  assert.equal(h.kills(), 1)
  assert.equal(h.stream.isClosed(), true)
  assert.match(
    h.notifications.at(-1)!,
    /\[Monitor stopped — too much output \(\d+ events suppressed over 3\ds\)\. Restart with a more selective source\.\]/,
  )
  const count = h.notifications.length
  h.stream.onData('ignored\n')
  h.fireTimers()
  assert.equal(h.notifications.length, count)
})

test('notice bypasses batching and close drops pending lines', () => {
  const h = harness()
  h.stream.onData('pending\n')
  h.stream.notice('[expired]')
  assert.equal(eventBody(h.notifications[0]!), '[expired]')
  h.stream.close()
  assert.equal(h.pendingTimers(), 0)
  h.stream.flush(true)
  assert.equal(h.notifications.length, 1)
})
