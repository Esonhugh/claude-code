import { afterEach, expect, test } from 'bun:test'
import { createTaskStateBase } from '../Task.js'
import { clearCommandQueue, getCommandQueueSnapshot } from '../utils/messageQueueManager.js'
import type { LocalAgentTaskState } from './LocalAgentTask/LocalAgentTask.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask/LocalWorkflowTask.js'
import { enqueueStopSweepNotices } from './userStopNotice.js'

afterEach(() => clearCommandQueue())

async function queued() {
  // Main-thread notifications go through the inbound receiver, a microtask away.
  await Promise.resolve()
  return getCommandQueueSnapshot()
}

const agent = {
  ...createTaskStateBase('a1', 'local_agent', 'probe <x>', 'toolu_2'),
  type: 'local_agent',
} as LocalAgentTaskState

const workflow = (fields: Partial<LocalWorkflowTaskState>) => ({
  ...createTaskStateBase('w1', 'local_workflow', 'probe workflow', 'toolu_3'),
  type: 'local_workflow',
  ...fields,
}) as LocalWorkflowTaskState

test('an agent an SDK interrupt stopped gets a passive notice not to start it again', async () => {
  enqueueStopSweepNotices([agent], 'client')
  const [notice] = await queued()
  expect(notice).toMatchObject({ mode: 'task-notification', priority: 'next', passive: true, taskId: 'a1', sdkTaskNotificationSent: true })
  expect(notice!.value).toBe(`<task-notification>
<task-id>a1</task-id>
<tool-use-id>toolu_2</tool-use-id>
<status>killed</status>
<summary>Task "probe &lt;x&gt;" was stopped by the user or by the app connected to this session. It is no longer running and no result will follow. Do not start it again unless the user asks.</summary>
</task-notification>`)
})

test('a stopped service-side agent gets no source and no restart warning', async () => {
  enqueueStopSweepNotices([agent], 'service')
  const [notice] = await queued()
  expect(String(notice!.value)).toContain('<summary>Task "probe &lt;x&gt;" was stopped. It is no longer running and no result will follow.</summary>')
})

test('a stopped workflow says how to resume it when its script and run are known', async () => {
  enqueueStopSweepNotices([
    workflow({ scriptPath: '/s/probe.js', workflowRunId: 'wf_1', runArgs: { n: 1 } }),
    workflow({ id: 'w2' }),
    workflow({ id: 'w3', toolUseId: undefined }),
  ], 'client')
  const notices = await queued()
  expect(notices.map(n => n.taskId)).toEqual(['w1', 'w2'])
  expect(notices[0]!.value).toBe(`<task-notification>
<task-id>w1</task-id>
<tool-use-id>toolu_3</tool-use-id>
<status>killed</status>
<summary>Task "probe workflow" was stopped by the user or by the app connected to this session. No result will follow unless the user has it resumed.</summary>
<recovery>Its finished agent calls are saved. Only if the user asks you to resume it, call: Workflow({scriptPath: '/s/probe.js', resumeFromRunId: 'wf_1', args: {"n":1}})</recovery>
</task-notification>`)
  expect(String(notices[1]!.value)).toEndWith('resumed.</summary>\n</task-notification>')
})
