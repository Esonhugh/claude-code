import { beforeEach, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import type { WorkflowDryRunPlan } from '../../tools/WorkflowTool/workflowSpec.js'
import {
  type LocalWorkflowTaskState,
  MAX_WORKFLOW_EVENTS,
  recordWorkflowEvent,
  registerWorkflowTask,
} from './LocalWorkflowTask.js'

const plan: WorkflowDryRunPlan = {
  name: 'events', description: 'Events plan',
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

test('workflow events are capped to the most recent entries', () => {
  const { id } = registerWorkflowTask({ plan, setAppState, workflowRunId: 'wf_events' })
  const total = MAX_WORKFLOW_EVENTS + 5
  for (let index = 0; index < total; index++) {
    recordWorkflowEvent({
      taskId: id,
      setAppState,
      event: { type: 'workflow_progress', workflowRunId: 'wf_events', status: 'running', completedAgents: index, totalAgents: total, timestamp: index },
    })
  }
  const events = task(id).events
  expect(events).toHaveLength(MAX_WORKFLOW_EVENTS)
  expect(events[0]).toMatchObject({ timestamp: 5 })
  expect(events.at(-1)).toMatchObject({ timestamp: total - 1 })
})
