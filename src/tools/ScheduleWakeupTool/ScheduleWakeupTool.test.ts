import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'bun:test'

import {
  addSessionCronTask,
  getProjectRoot,
  getScheduledTasksEnabled,
  getSessionCronTasks,
  removeSessionCronTasks,
  setProjectRoot,
  setScheduledTasksEnabled,
} from '../../bootstrap/state.js'
import { createCronScheduler } from '../../utils/cronScheduler.js'
import type { CronTask } from '../../utils/cronTasks.js'
import { cancelLoopWakeups, clampWakeupDelay, ScheduleWakeupTool } from './ScheduleWakeupTool.js'

afterEach(() => {
  cancelLoopWakeups()
  removeSessionCronTasks(getSessionCronTasks().map(t => t.id))
  setScheduledTasksEnabled(false)
})

const context = {} as never

test('delays are clamped to [60, 3600] seconds', () => {
  assert.deepEqual(clampWakeupDelay(10), { clamped: 60, wasClamped: true })
  assert.deepEqual(clampWakeupDelay(270), { clamped: 270, wasClamped: false })
  assert.deepEqual(clampWakeupDelay(270.4), { clamped: 270, wasClamped: false })
  assert.deepEqual(clampWakeupDelay(99_999), { clamped: 3600, wasClamped: true })
  assert.deepEqual(clampWakeupDelay(Number.NaN), { clamped: 60, wasClamped: true })
  assert.deepEqual(clampWakeupDelay(Infinity), { clamped: 3600, wasClamped: true })
})

test('scheduling requires delaySeconds, reason, prompt and noop unless stopping', async () => {
  const missingDelay = await ScheduleWakeupTool.validateInput!(
    { reason: 'r', prompt: '/loop x', noop: true },
    context,
  )
  assert.equal(missingDelay.result, false)
  const missingPrompt = await ScheduleWakeupTool.validateInput!(
    { delaySeconds: 60, reason: 'r', noop: true },
    context,
  )
  assert.equal(missingPrompt.result, false)
  const missingNoop = await ScheduleWakeupTool.validateInput!(
    { delaySeconds: 60, reason: 'r', prompt: '/loop x' },
    context,
  )
  assert.equal(missingNoop.result, false)
  assert.deepEqual(
    await ScheduleWakeupTool.validateInput!({ stop: true }, context),
    { result: true },
  )
})

test('a wakeup is a session-only loop task that fires at the exact time and supersedes the pending one', async () => {
  const before = Date.now()
  const first = await ScheduleWakeupTool.call(
    { delaySeconds: 270, reason: 'watching CI', prompt: '/loop check CI', noop: false },
    context,
  )
  assert.equal(first.data.clampedDelaySeconds, 270)
  assert.equal(first.data.wasClamped, false)
  assert.ok(first.data.scheduledFor >= before + 270_000)
  assert.equal(getScheduledTasksEnabled(), true)

  const second = await ScheduleWakeupTool.call(
    { delaySeconds: 5, reason: 'quick recheck', prompt: '/loop check CI', noop: true },
    context,
  )
  assert.equal(second.data.clampedDelaySeconds, 60)
  assert.equal(second.data.wasClamped, true)

  const tasks = getSessionCronTasks()
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]!.kind, 'loop')
  assert.equal(tasks[0]!.prompt, '/loop check CI')
  assert.equal(tasks[0]!.scheduledFor, second.data.scheduledFor)
  assert.equal(tasks[0]!.recurring, undefined)

  const block = ScheduleWakeupTool.mapToolResultToToolResultBlockParam(second.data, 'toolu_1')
  assert.match(
    String(block.content),
    /^Next wakeup scheduled for \d\d:\d\d:\d\d \(in \d+s\) \(clamped to 60s from your requested value\)\. /,
  )
})

test('stop cancels pending loop wakeups but leaves other cron tasks alone', async () => {
  addSessionCronTask({ id: 'cron0001', cron: '*/5 * * * *', prompt: 'other', createdAt: Date.now(), recurring: true })
  await ScheduleWakeupTool.call(
    { delaySeconds: 600, reason: 'idle', prompt: '/loop tidy', noop: true },
    context,
  )
  const stopped = await ScheduleWakeupTool.call({ stop: true }, context)
  assert.equal(stopped.data.stopped, true)
  assert.equal(stopped.data.cancelledWakeups, 1)
  assert.deepEqual(getSessionCronTasks().map(t => t.id), ['cron0001'])
  assert.match(
    String(ScheduleWakeupTool.mapToolResultToToolResultBlockParam(stopped.data, 't').content),
    /^Loop stopped — cancelled 1 pending wakeup\(s\)/,
  )

  const again = await ScheduleWakeupTool.call({ stop: true }, context)
  assert.equal(again.data.cancelledWakeups, 0)
  assert.match(
    String(ScheduleWakeupTool.mapToolResultToToolResultBlockParam(again.data, 't').content),
    /there was no pending wakeup to cancel.*CronDelete/,
  )
})

test('the cron scheduler fires a loop wakeup at scheduledFor instead of its cron minute', async () => {
  const previousRoot = getProjectRoot()
  const root = mkdtempSync(join(tmpdir(), 'wakeup-scheduler-'))
  setProjectRoot(root)
  const fired: CronTask[] = []
  const scheduler = createCronScheduler({
    onFire: () => {},
    onFireTask: task => fired.push(task),
    isLoading: () => false,
  })
  try {
    const now = Date.now()
    // The cron field points a year away; only scheduledFor can fire it.
    const far = new Date(now - 60 * 60 * 1000)
    addSessionCronTask({
      id: 'loop0001',
      cron: `${far.getMinutes()} ${far.getHours()} * * *`,
      prompt: '/loop check CI',
      createdAt: now,
      kind: 'loop',
      scheduledFor: now + 1200,
    })
    setScheduledTasksEnabled(true)
    scheduler.start()
    const deadline = Date.now() + 5000
    while (fired.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(fired.length, 1)
    assert.equal(fired[0]!.prompt, '/loop check CI')
    assert.ok(Date.now() >= now + 1200)
    assert.equal(getSessionCronTasks().length, 0)
  } finally {
    scheduler.stop()
    setProjectRoot(previousRoot)
    rmSync(root, { recursive: true, force: true })
  }
})
