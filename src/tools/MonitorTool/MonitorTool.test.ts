import assert from 'node:assert/strict'
import { afterEach, spyOn, test } from 'bun:test'

import { getDefaultAppState, type AppState } from '../../state/AppState.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import * as messageQueue from '../../utils/messageQueueManager.js'
import { MonitorTool } from './MonitorTool.js'
import { buildMonitorExpiryMessage, MONITOR_TOOL_NAME } from './prompt.js'

afterEach(() => {
  messageQueue.resetCommandQueue()
})

function makeContext() {
  let state = {
    ...getDefaultAppState(),
    toolPermissionContext: getEmptyToolPermissionContext(),
  } as AppState
  const context = {
    abortController: new AbortController(),
    getAppState: () => state,
    setAppState: (fn: (prev: AppState) => AppState) => {
      state = fn(state)
    },
    toolUseId: 'toolu_monitor_test',
    // Agent-scoped notifications enqueue synchronously.
    agentId: 'monitor-test-agent' as AgentId,
  }
  return { context, getState: () => state }
}

function queuedValues(): string[] {
  return messageQueue.getCommandQueue().map(command => String(command.value))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('Monitor is enabled unless background tasks are disabled', () => {
  assert.equal(MonitorTool.name, MONITOR_TOOL_NAME)
  assert.equal(MonitorTool.isEnabled(), true)
  process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
  try {
    assert.equal(MonitorTool.isEnabled(), false)
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
  }
})

test('input schema caps timeout_ms at one hour and defaults to five minutes', () => {
  const parsed = MonitorTool.inputSchema.parse({
    description: 'd',
    command: 'echo hi',
  })
  assert.equal(parsed.timeout_ms, 300_000)
  assert.equal(
    MonitorTool.inputSchema.safeParse({
      description: 'd',
      command: 'echo hi',
      timeout_ms: 3_600_001,
    }).success,
    false,
  )
})

test('expiry message reports the delivered event count', () => {
  assert.equal(
    buildMonitorExpiryMessage(300_000, 0),
    '[Monitor expired after 5m with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]',
  )
  assert.equal(
    buildMonitorExpiryMessage(1_800_000, 1),
    '[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]',
  )
})

test('each stdout line of the script becomes a task notification, then the stream ends', async () => {
  const { context, getState } = makeContext()
  const result = await MonitorTool.call(
    {
      description: 'file changes',
      command: "echo 'changed a.txt'; sleep 0.5; echo 'changed b.txt'",
      timeout_ms: 60_000,
    },
    context as never,
  )
  const { taskId, timeoutMs } = result.data
  assert.equal(timeoutMs, 60_000)
  const task = getState().tasks[taskId] as { kind?: string; type: string }
  assert.equal(task.type, 'local_bash')
  assert.equal(task.kind, 'monitor')

  await waitFor(() => queuedValues().some(v => v.includes('<status>completed</status>')))
  const values = queuedValues()
  assert.equal(values.length, 3)
  assert.match(values[0]!, /<summary>Monitor event: "file changes"<\/summary>\n<event>changed a\.txt<\/event>/)
  assert.match(values[1]!, /<event>changed b\.txt<\/event>/)
  // The end-of-stream notice follows the last event.
  assert.match(values[2]!, /<status>completed<\/status>/)
  const events = messageQueue.getCommandQueue().slice(0, 2)
  assert.ok(
    events.every(command => command.mode === 'task-notification' && command.priority === 'next'),
  )
})

test('output of a script that exits immediately is still delivered before the end notice', async () => {
  const { context } = makeContext()
  await MonitorTool.call(
    { description: 'quick', command: "printf 'one\\ntwo\\nthree'", timeout_ms: 60_000 },
    context as never,
  )
  await waitFor(() => queuedValues().some(v => v.includes('<status>completed</status>')))
  const values = queuedValues()
  assert.equal(values.length, 2)
  assert.match(values[0]!, /<event>one\ntwo\nthree<\/event>/)
})

test('a monitor that outlives its deadline is killed with one expiry notice', async () => {
  const { context, getState } = makeContext()
  const result = await MonitorTool.call(
    {
      description: 'never ends',
      command: 'echo started; sleep 30',
      timeout_ms: 1000,
    },
    context as never,
  )
  const { taskId } = result.data
  await waitFor(() => getState().tasks[taskId]?.status === 'killed')
  await new Promise(resolve => setTimeout(resolve, 100))
  const values = queuedValues()
  assert.equal(values.length, 2)
  assert.match(values[0]!, /<event>started<\/event>/)
  assert.match(
    values[1]!,
    /\[Monitor expired after 1s with 1 event delivered\. Re-arm it if you still need the watch\.\]/,
  )
})

test('tool result tells the model to keep working instead of polling', () => {
  const block = MonitorTool.mapToolResultToToolResultBlockParam(
    { taskId: 'b42', timeoutMs: 300_000 },
    'toolu_1',
  )
  assert.equal(
    block.content,
    'Monitor started (task b42, expires in 5m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.',
  )
})

test('sandbox auto-allow does not apply to monitor commands', async () => {
  const { SandboxManager } = await import('../../utils/sandbox/sandbox-adapter.js')
  const { bashToolHasPermission } = await import('../BashTool/bashPermissions.js')
  const spies = [
    spyOn(SandboxManager, 'isSandboxingEnabled').mockReturnValue(true),
    spyOn(SandboxManager, 'isAutoAllowBashIfSandboxedEnabled').mockReturnValue(true),
    spyOn(SandboxManager, 'areUnsandboxedCommandsAllowed').mockReturnValue(true),
  ]
  try {
    const { context } = makeContext()
    const command = 'touch monitor-auto-allow-probe'
    const bash = await bashToolHasPermission({ command }, context as never)
    assert.equal(bash.behavior, 'allow')
    const monitor = await MonitorTool.checkPermissions(
      { command, description: 'probe', timeout_ms: 300_000 },
      context as never,
    )
    assert.notEqual(monitor.behavior, 'allow')
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
})
