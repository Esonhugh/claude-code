import { describe, expect, test } from 'bun:test'

import type { AppState } from './AppStateStore.js'
import { getViewedAgentTask, getViewedTeammateTask } from './selectors.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'

const localAgentTask = {
  id: 'agent-1',
  type: 'local_agent',
  status: 'running',
  description: 'Read the agent transcript',
  prompt: 'Read the agent transcript',
  agentId: 'agent-1',
  agentType: 'general-purpose',
  spawnDepth: 1,
  startTime: 1,
  outputFile: '/tmp/agent-1.output',
  outputOffset: 0,
  notified: false,
  retain: true,
  diskLoaded: true,
  messages: [],
} as unknown as LocalAgentTaskState

const teammateTask = {
  id: 'teammate-1',
  type: 'in_process_teammate',
  status: 'running',
  description: 'Read the teammate transcript',
  identity: {},
  prompt: 'Read the teammate transcript',
  awaitingPlanApproval: false,
  permissionMode: 'default',
  pendingUserMessages: [],
  isIdle: false,
  shutdownRequested: false,
  lastReportedToolCount: 0,
  lastReportedTokenCount: 0,
  startTime: 1,
  outputFile: '/tmp/teammate-1.output',
  outputOffset: 0,
  notified: false,
  messages: [],
} as unknown as InProcessTeammateTaskState

function appState(
  viewingAgentTaskId: string | undefined,
  tasks: AppState['tasks'],
): Pick<AppState, 'viewingAgentTaskId' | 'tasks'> {
  return { viewingAgentTaskId, tasks }
}

describe('viewed agent selectors', () => {
  test('returns no task when no agent is selected', () => {
    expect(getViewedAgentTask(appState(undefined, {}))).toBeUndefined()
  })

  test('does not fall back to another task for an invalid selected ID', () => {
    expect(
      getViewedAgentTask(
        appState('missing', { [localAgentTask.id]: localAgentTask }),
      ),
    ).toBeUndefined()
  })

  test('returns the selected local agent task', () => {
    expect(
      getViewedAgentTask(
        appState(localAgentTask.id, { [localAgentTask.id]: localAgentTask }),
      ),
    ).toBe(localAgentTask)
  })

  test('returns the selected in-process teammate task', () => {
    expect(
      getViewedAgentTask(
        appState(teammateTask.id, { [teammateTask.id]: teammateTask }),
      ),
    ).toBe(teammateTask)
  })

  test('keeps teammate selector scoped to in-process teammates', () => {
    expect(
      getViewedTeammateTask(
        appState(localAgentTask.id, { [localAgentTask.id]: localAgentTask }),
      ),
    ).toBeUndefined()
    expect(
      getViewedTeammateTask(
        appState(teammateTask.id, { [teammateTask.id]: teammateTask }),
      ),
    ).toBe(teammateTask)
  })
})

