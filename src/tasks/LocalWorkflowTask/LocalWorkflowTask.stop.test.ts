import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { WorkflowDryRunPlan } from '../../tools/WorkflowTool/workflowSpec.js'
import { clearCommandQueue, getCommandQueueSnapshot } from '../../utils/messageQueueManager.js'
import {
  killWorkflowTask,
  type LocalWorkflowTaskState,
  pauseWorkflowTask,
  registerWorkflowTask,
} from './LocalWorkflowTask.js'

const plan: WorkflowDryRunPlan = {
  name: 'stop', description: 'probe workflow',
  defaults: { maxConcurrency: 1, maxAgents: 1, maxRetries: 0, fanout: 1, concurrency: 1, review: 'none', permissionMode: 'bypassPermissions', execution: 'agent' },
  phases: [{ id: 'root', description: 'Root', prompt: 'Reply once', dependsOn: [], fanout: 1, concurrency: 1, review: 'none', permissionMode: 'bypassPermissions' }],
  totalAgents: 1, runScriptSnapshot: 'phase("root")',
}

let state: AppState
const setAppState = (update: (prev: AppState) => AppState) => {
  state = update(state)
}
const task = (id: string) => state.tasks[id] as LocalWorkflowTaskState

async function queued() {
  // Main-thread notifications go through the inbound receiver, a microtask away.
  await Promise.resolve()
  return getCommandQueueSnapshot()
}

beforeEach(() => {
  state = { tasks: {} } as unknown as AppState
})
afterEach(() => clearCommandQueue())

test('the user stopping a running workflow queues a passive notice and keeps the run from notifying', async () => {
  const { id } = registerWorkflowTask({ plan, setAppState, toolUseId: 'toolu_2', workflowRunId: 'wf_stop', scriptPath: '/s/probe.js' })
  killWorkflowTask(id, setAppState)
  expect(task(id)).toMatchObject({ status: 'killed', notified: true })

  const [notice, ...rest] = await queued()
  expect(rest).toEqual([])
  expect(notice).toMatchObject({ mode: 'task-notification', priority: 'next', passive: true, taskId: id })
  expect(notice!.value).toBe(`<task-notification>
<task-id>${id}</task-id>
<tool-use-id>toolu_2</tool-use-id>
<status>killed</status>
<summary>Task "probe workflow" was stopped by the user. No result will follow unless the user has it resumed.</summary>
<recovery>Its finished agent calls are saved. Only if the user asks you to resume it, call: Workflow({scriptPath: '/s/probe.js', resumeFromRunId: 'wf_stop'})</recovery>
</task-notification>`)

  killWorkflowTask(id, setAppState)
  expect(await queued()).toHaveLength(1)
})

test('stopping a paused workflow or one with no tool call queues nothing', async () => {
  const paused = registerWorkflowTask({ plan, setAppState, toolUseId: 'toolu_3' }).id
  pauseWorkflowTask(paused, setAppState)
  const untracked = registerWorkflowTask({ plan, setAppState }).id
  killWorkflowTask(paused, setAppState)
  killWorkflowTask(untracked, setAppState)

  expect(task(paused)).toMatchObject({ status: 'killed', notified: false })
  expect(task(untracked)).toMatchObject({ status: 'killed', notified: true })
  expect(await queued()).toEqual([])
})
