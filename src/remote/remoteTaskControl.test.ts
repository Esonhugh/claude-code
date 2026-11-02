import { expect, test } from 'bun:test'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { applyRemoteTaskEvent, createRemoteTaskControl } from './remoteTaskControl.js'

const event = (fields: Record<string, unknown>) =>
  ({ type: 'system', uuid: 'u', session_id: 's', ...fields }) as unknown as SDKMessage

test('applyRemoteTaskEvent tracks a task from start to notification', () => {
  const started = applyRemoteTaskEvent({}, event({ subtype: 'task_started', task_id: 'a1', task_type: 'local_agent', description: 'research' }))
  expect(started.a1).toMatchObject({ taskId: 'a1', taskType: 'local_agent', description: 'research' })
  const progressEvent = event({ subtype: 'task_progress', task_id: 'a1', description: 'research', usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 }, last_tool_name: 'Read' })
  const progressed = applyRemoteTaskEvent(started, progressEvent)
  expect(progressed.a1).toMatchObject({ usage: { totalTokens: 10, toolUses: 1, durationMs: 5 }, lastToolName: 'Read' })
  expect(applyRemoteTaskEvent(progressed, progressEvent)).toBe(progressed)
  expect(applyRemoteTaskEvent(progressed, event({ subtype: 'task_notification', task_id: 'a1', status: 'completed' }))).toEqual({})
  expect(applyRemoteTaskEvent(progressed, event({ subtype: 'init' }))).toBe(progressed)
})

test('createRemoteTaskControl maps to send_task_message, stop_task and get_task_output', async () => {
  const requests: Record<string, unknown>[] = []
  const control = createRemoteTaskControl(async request => {
    requests.push(request)
    return request.subtype === 'send_task_message' ? { delivery: 'injected' } : request.subtype === 'get_task_output' ? { output: 'screen' } : {}
  })
  expect(await control.sendTaskMessage('t1', 'hi')).toBe('injected')
  expect(await control.getTaskOutput('term')).toBe('screen')
  await control.stopTask('a1')
  expect(requests).toEqual([
    { subtype: 'send_task_message', task_id: 't1', text: 'hi' },
    { subtype: 'get_task_output', task_id: 'term' },
    { subtype: 'stop_task', task_id: 'a1' },
  ])
})
