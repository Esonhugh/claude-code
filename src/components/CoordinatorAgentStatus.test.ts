import assert from 'node:assert/strict'

import type { AppState } from '../state/AppState.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalWorkflowTaskState } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  getCoordinatorSessionRows,
  getCoordinatorTaskAtIndex,
  getVisibleAgentTasks,
} from './CoordinatorAgentStatusRows.js'

const agentTask: LocalAgentTaskState = {
  id: 'agent-1',
  type: 'local_agent',
  status: 'running',
  description: 'Research user reports',
  prompt: 'Research user reports',
  startTime: 1_000,
  outputFile: '.claude/tasks/agent-1.output',
  outputOffset: 0,
  notified: false,
  progress: {
    tokenCount: 1500,
    toolUseCount: 2,
    lastActivity: 'Read(src/index.ts)',
  },
} as unknown as LocalAgentTaskState

const workflowChildAgentTask: LocalAgentTaskState = {
  id: 'workflow-child-agent',
  type: 'local_agent',
  status: 'running',
  description: 'tmux-agent-smoke: Run',
  prompt: 'Run workflow child agent',
  startTime: 2_500,
  outputFile: '.claude/tasks/workflow-child-agent.output',
  outputOffset: 0,
  notified: false,
  toolUseId: 'workflow-tool-use',
  progress: {
    tokenCount: 500,
    toolUseCount: 1,
  },
} as unknown as LocalAgentTaskState

const nestedChildAgentTask: LocalAgentTaskState = {
  id: 'nested-child-agent',
  type: 'local_agent',
  status: 'running',
  description: 'Nested child agent',
  prompt: 'Run nested child agent',
  startTime: 1_500,
  outputFile: '.claude/tasks/nested-child-agent.output',
  outputOffset: 0,
  notified: false,
  parentAgentId: 'agent-1',
  spawnDepth: 2,
  progress: {
    tokenCount: 100,
    toolUseCount: 1,
  },
} as unknown as LocalAgentTaskState

const topLevelDepthOneAgentTask: LocalAgentTaskState = {
  ...agentTask,
  id: 'top-level-depth-one-agent',
  agentId: 'top-level-depth-one-agent',
  description: 'Top level depth one agent',
  prompt: 'Run top level depth one agent',
  startTime: 1_750,
  parentAgentId: undefined,
  spawnDepth: 1,
  progress: {
    tokenCount: 700,
    toolUseCount: 3,
  },
} as unknown as LocalAgentTaskState

const workflowTask: LocalWorkflowTaskState = {
  id: 'workflow-1',
  type: 'local_workflow',
  status: 'completed',
  description: 'Workflow: tmux-agent-smoke',
  workflowName: 'tmux-agent-smoke',
  summary: 'Workflow completed',
  agentCount: 1,
  tokenCount: 19591,
  toolUseCount: 0,
  defaultModel: 'gpt-5.5[1m]',
  startTime: 2_000,
  endTime: 4_000,
  outputFile: '.claude/tasks/workflow-1.output',
  outputOffset: 0,
  notified: false,
  toolUseId: 'workflow-tool-use',
  phases: [
    {
      id: 'Run',
      status: 'completed',
      agentIds: ['tmux-agent-smoke'],
      completedAgentIds: ['tmux-agent-smoke'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [
        {
          phaseId: 'Run',
          agentId: 'tmux-agent-smoke',
          index: 0,
          status: 'completed',
          output: 'TMUX_WORKFLOW_AGENT_OK',
          tokenCount: 19591,
          toolUseCount: 0,
          durationMs: 2319,
        },
      ],
    },
  ],
  results: [
    {
      phaseId: 'Run',
      agentId: 'tmux-agent-smoke',
      index: 0,
      status: 'completed',
      output: 'TMUX_WORKFLOW_AGENT_OK',
      tokenCount: 19591,
      toolUseCount: 0,
      durationMs: 2319,
    },
  ],
  events: [],
}

const tasks = {
  [agentTask.id]: agentTask,
  [nestedChildAgentTask.id]: nestedChildAgentTask,
  [topLevelDepthOneAgentTask.id]: topLevelDepthOneAgentTask,
  [workflowChildAgentTask.id]: workflowChildAgentTask,
  [workflowTask.id]: workflowTask,
} as unknown as AppState['tasks']

assert.deepEqual(
  getVisibleAgentTasks(tasks).map(task => task.id),
  ['agent-1', 'top-level-depth-one-agent', 'workflow-1'],
)

const rows = getCoordinatorSessionRows({
  tasks,
  selectedIndex: 3,
  viewingAgentTaskId: undefined,
  nameByAgentId: new Map([['agent-1', 'researcher']]),
  now: 5_000,
})

assert.equal(rows.length, 4)
assert.equal(rows.some(row => row.id === 'nested-child-agent'), false)
assert.deepEqual(rows[0], {
  id: 'main',
  taskId: undefined,
  kind: 'main',
  selected: false,
  viewed: true,
  icon: '●',
  label: 'main',
  meta: '',
  statusText: 'current session',
})
assert.equal(rows[1]?.id, 'agent-1')
assert.equal(rows[1]?.kind, 'agent')
assert.equal(rows[1]?.label, 'agent researcher')
assert.equal(rows[1]?.meta, '1.5k tok · 2 tools')
assert.equal(rows[1]?.statusText, 'running · Read(src/index.ts)')
assert.equal(rows[2]?.id, 'top-level-depth-one-agent')
assert.equal(rows[2]?.kind, 'agent')
assert.equal(rows[2]?.label, 'agent Top level depth one agent')
assert.equal(rows[2]?.meta, '700 tok · 3 tools')
assert.equal(rows[3]?.id, 'workflow-1')
assert.equal(rows[3]?.kind, 'workflow')
assert.equal(rows[3]?.selected, true)
assert.equal(rows[3]?.label, 'tmux-agent-smoke')
assert.equal(rows[3]?.meta, '1/1 agents · 19.6k tok')
assert.equal(rows[3]?.statusText, 'done · 2s')

const stagedWorkflowRows = getCoordinatorSessionRows({
  tasks: {
    staged: {
      ...workflowTask,
      id: 'staged',
      status: 'running',
      agentCount: 4,
      phases: [
        { id: 'fanout', status: 'running', agentIds: ['a1', 'a2', 'a3'], completedAgentIds: [], skippedAgentIds: [], failedAgentIds: [], results: [] },
        { id: 'after', status: 'pending', agentIds: [], completedAgentIds: [], skippedAgentIds: [], failedAgentIds: [], results: [] },
      ],
    },
  } as unknown as AppState['tasks'],
  selectedIndex: 0,
  viewingAgentTaskId: undefined,
  nameByAgentId: new Map(),
  now: 5_000,
  omitMainRow: true,
})
assert.equal(stagedWorkflowRows[0]?.meta, '0/4 agents · 19.6k tok')

const workflowOnlyRows = getCoordinatorSessionRows({
  tasks: { [workflowTask.id]: workflowTask } as unknown as AppState['tasks'],
  selectedIndex: 0,
  viewingAgentTaskId: undefined,
  nameByAgentId: new Map(),
  now: 5_000,
  omitMainRow: true,
})
assert.equal(workflowOnlyRows.length, 1)
assert.equal(workflowOnlyRows[0]?.kind, 'workflow')
assert.equal(workflowOnlyRows[0]?.selected, true)
assert.equal(workflowOnlyRows[0]?.label, 'tmux-agent-smoke')
assert.equal(
  getCoordinatorTaskAtIndex(
    { [workflowTask.id]: workflowTask } as unknown as AppState['tasks'],
    0,
    true,
  )?.id,
  'workflow-1',
)
assert.equal(getCoordinatorTaskAtIndex(tasks, 0)?.id, undefined)
assert.equal(getCoordinatorTaskAtIndex(tasks, 2)?.id, 'top-level-depth-one-agent')
assert.equal(getCoordinatorTaskAtIndex(tasks, 3)?.id, 'workflow-1')

console.log('CoordinatorAgentStatus.test.ts passed')
