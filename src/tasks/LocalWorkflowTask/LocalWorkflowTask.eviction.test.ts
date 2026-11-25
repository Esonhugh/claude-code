import { beforeEach, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { WorkflowDryRunPlan } from '../../tools/WorkflowTool/workflowSpec.js'
import { PANEL_GRACE_MS } from '../../utils/task/framework.js'
import {
  completeWorkflowTask,
  dismissWorkflowTask,
  failWorkflowTask,
  killWorkflowTask,
  type LocalWorkflowTaskState,
  pauseWorkflowTask,
  registerWorkflowTask,
} from './LocalWorkflowTask.js'

const plan: WorkflowDryRunPlan = {
  name: 'eviction', description: 'Eviction plan',
  defaults: { maxConcurrency: 1, maxAgents: 1, maxRetries: 0, fanout: 1, concurrency: 1, review: 'none', permissionMode: 'bypassPermissions', execution: 'agent' },
  phases: [{ id: 'root', description: 'Root', prompt: 'Reply once', dependsOn: [], fanout: 1, concurrency: 1, review: 'none', permissionMode: 'bypassPermissions' }],
  totalAgents: 1, runScriptSnapshot: 'phase("root")',
}

let state: AppState
const setAppState = (update: (prev: AppState) => AppState) => {
  state = update(state)
}
const task = (id: string) => state.tasks[id] as LocalWorkflowTaskState

beforeEach(() => {
  state = { tasks: {} } as unknown as AppState
})

test('terminal workflow transitions set evictAfter to endTime + PANEL_GRACE_MS', () => {
  const completed = registerWorkflowTask({ plan, setAppState }).id
  const failed = registerWorkflowTask({ plan, setAppState }).id
  const killed = registerWorkflowTask({ plan, setAppState }).id
  expect(task(completed).evictAfter).toBeUndefined()

  completeWorkflowTask(completed, setAppState)
  failWorkflowTask(failed, 'boom', setAppState)
  killWorkflowTask(killed, setAppState)

  for (const id of [completed, failed, killed]) {
    expect(task(id).endTime).toBeNumber()
    expect(task(id).evictAfter).toBe(task(id).endTime! + PANEL_GRACE_MS)
  }
})

test('pausing a workflow does not set evictAfter', () => {
  const { id } = registerWorkflowTask({ plan, setAppState })
  pauseWorkflowTask(id, setAppState)
  expect(task(id).status).toBe('pending')
  expect(task(id).evictAfter).toBeUndefined()
})

test('dismissing a finished workflow drops it and its finished agents at once', () => {
  const running = registerWorkflowTask({ plan, setAppState, toolUseId: 'toolu_wf' }).id
  const agent = (id: string, status: string, toolUseId: string) =>
    ({ id, type: 'local_agent', status, toolUseId }) as unknown as AppState['tasks'][string]
  state = {
    ...state,
    tasks: {
      ...state.tasks,
      child: agent('child', 'killed', 'toolu_wf'),
      live: agent('live', 'running', 'toolu_wf'),
      other: agent('other', 'completed', 'toolu_other'),
    },
  }
  dismissWorkflowTask(running, setAppState)
  expect(task(running)).toBeDefined()

  killWorkflowTask(running, setAppState)
  dismissWorkflowTask(running, setAppState)
  expect(Object.keys(state.tasks).sort()).toEqual(['live', 'other'])
})
