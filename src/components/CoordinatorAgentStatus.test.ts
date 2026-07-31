import assert from 'node:assert/strict'

import type { AppState } from '../state/AppState.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalWorkflowTaskState } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  getCoordinatorSessionRows,
  getCoordinatorTaskAtIndex,
  getCoordinatorTaskCount,
  getCoordinatorTaskIndex,
  getVisibleAgentTasks,
} from './CoordinatorAgentStatusRows.js'

const agentTask: LocalAgentTaskState = {
  id: 'agent-1',
  type: 'local_agent',
  status: 'running',
  description: 'Research user reports',
  prompt: 'Research user reports',
  agentId: 'agent-1',
  agentType: 'general-purpose',
  spawnDepth: 1,
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
  agentId: 'workflow-child-agent',
  agentType: 'general-purpose',
  spawnDepth: 1,
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

const workflowGrandchildAgentTask: LocalAgentTaskState = {
  ...workflowChildAgentTask,
  id: 'workflow-grandchild-agent',
  agentId: 'workflow-grandchild-agent',
  description: 'Workflow grandchild agent',
  prompt: 'Run workflow grandchild agent',
  startTime: 2_600,
  toolUseId: undefined,
  parentAgentId: 'workflow-child-agent',
  spawnDepth: 2,
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
  agentId: 'nested-child-agent',
  agentType: 'Explore',
  spawnDepth: 2,
  progress: {
    tokenCount: 100,
    toolUseCount: 1,
  },
} as unknown as LocalAgentTaskState

const nestedSiblingAgentTask: LocalAgentTaskState = {
  ...nestedChildAgentTask,
  id: 'nested-sibling-agent',
  agentId: 'nested-sibling-agent',
  description: 'Nested sibling agent',
  prompt: 'Run nested sibling agent',
  agentType: 'Plan',
  startTime: 1_600,
} as unknown as LocalAgentTaskState

const nestedGrandchildAgentTask: LocalAgentTaskState = {
  ...nestedChildAgentTask,
  id: 'nested-grandchild-agent',
  agentId: 'nested-grandchild-agent',
  description: 'Nested grandchild agent',
  prompt: 'Run nested grandchild agent',
  agentType: 'general-purpose',
  startTime: 1_550,
  parentAgentId: 'nested-child-agent',
  spawnDepth: 3,
} as unknown as LocalAgentTaskState

const orphanAgentTask: LocalAgentTaskState = {
  ...nestedChildAgentTask,
  id: 'orphan-agent',
  agentId: 'orphan-agent',
  description: 'Orphan agent',
  prompt: 'Run orphan agent',
  startTime: 1_700,
  parentAgentId: 'missing-parent',
} as unknown as LocalAgentTaskState

const topLevelDepthOneAgentTask: LocalAgentTaskState = {
  ...agentTask,
  id: 'top-level-depth-one-agent',
  agentId: 'top-level-depth-one-agent',
  description: 'Top level depth one agent',
  prompt: 'Run top level depth one agent',
  agentType: 'researcher',
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
  meta: {
    name: 'tmux-agent-smoke',
    description: 'Exercise the coordinator workflow row.',
  },
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
  [nestedSiblingAgentTask.id]: nestedSiblingAgentTask,
  [nestedGrandchildAgentTask.id]: nestedGrandchildAgentTask,
  [orphanAgentTask.id]: orphanAgentTask,
  [topLevelDepthOneAgentTask.id]: topLevelDepthOneAgentTask,
  [workflowChildAgentTask.id]: workflowChildAgentTask,
  [workflowGrandchildAgentTask.id]: workflowGrandchildAgentTask,
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
  now: 5_000,
})

assert.equal(rows.length, 4)
assert.deepEqual(rows[0], {
  id: 'main',
  taskId: undefined,
  kind: 'main',
  selected: false,
  viewed: true,
  icon: '●',
  primaryText: 'main',
  secondaryText: '',
  meta: '',
  statusText: 'current session',
  depth: 0,
  branch: 'none',
})
assert.equal(rows[1]?.id, 'agent-1')
assert.equal(rows[1]?.kind, 'agent')
assert.equal(rows[1]?.icon, '◯')
assert.equal(rows[1]?.primaryText, 'general-purpose (+3)')
assert.equal(rows[1]?.secondaryText, 'Research user reports')
assert.equal(rows[1]?.meta, '1.5k tok · 2 tools')
assert.equal(rows[1]?.statusText, 'running · Read(src/index.ts)')
assert.equal(rows[2]?.id, 'top-level-depth-one-agent')
assert.equal(rows[2]?.kind, 'agent')
assert.equal(rows[2]?.icon, '◯')
assert.equal(rows[2]?.primaryText, 'researcher')
assert.equal(rows[2]?.secondaryText, 'Top level depth one agent')
assert.equal(rows[2]?.meta, '700 tok · 3 tools')
assert.equal(rows[3]?.id, 'workflow-1')
assert.equal(rows[3]?.kind, 'workflow')
assert.equal(rows[3]?.selected, true)
assert.equal(rows[3]?.icon, '◯')
assert.equal(rows[3]?.primaryText, 'tmux-agent-smoke')
assert.equal(rows[3]?.secondaryText, 'Exercise the coordinator workflow row.')
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
  now: 5_000,
})
assert.equal(stagedWorkflowRows[0]?.meta, '0/4 agents · 19.6k tok')

const workflowOnlyRows = getCoordinatorSessionRows({
  tasks: { [workflowTask.id]: workflowTask } as unknown as AppState['tasks'],
  selectedIndex: 0,
  viewingAgentTaskId: undefined,
  now: 5_000,
})
assert.equal(workflowOnlyRows.length, 1)
assert.equal(workflowOnlyRows[0]?.kind, 'workflow')
assert.equal(workflowOnlyRows[0]?.selected, true)
assert.equal(workflowOnlyRows[0]?.icon, '◯')
assert.equal(workflowOnlyRows[0]?.primaryText, 'tmux-agent-smoke')
assert.equal(
  workflowOnlyRows[0]?.secondaryText,
  'Exercise the coordinator workflow row.',
)
assert.equal(
  getCoordinatorTaskAtIndex(
    { [workflowTask.id]: workflowTask } as unknown as AppState['tasks'],
    0,
  )?.id,
  'workflow-1',
)
assert.equal(getCoordinatorTaskAtIndex(tasks, 0)?.id, undefined)
assert.equal(getCoordinatorTaskAtIndex(tasks, 1)?.id, 'agent-1')
assert.equal(getCoordinatorTaskAtIndex(tasks, 2)?.id, 'top-level-depth-one-agent')
assert.equal(getCoordinatorTaskAtIndex(tasks, 3)?.id, 'workflow-1')
assert.equal(getCoordinatorTaskCount(tasks), 4)
assert.equal(getCoordinatorTaskIndex(tasks, 'workflow-1'), 3)

function assertLayoutConsistency(
  layoutTasks: AppState['tasks'],
  viewingAgentTaskId: string | undefined,
  expectedTaskIds: string[],
): void {
  const visibleTaskIds = getVisibleAgentTasks(
    layoutTasks,
    viewingAgentTaskId,
  ).map(task => task.id)
  assert.deepEqual(visibleTaskIds, expectedTaskIds)
  assert.equal(
    getCoordinatorTaskCount(layoutTasks, viewingAgentTaskId),
    expectedTaskIds.length + 1,
  )
  expectedTaskIds.forEach((taskId, taskOffset) => {
    const rowIndex = taskOffset + 1
    assert.equal(
      getCoordinatorTaskAtIndex(
        layoutTasks,
        rowIndex,
        viewingAgentTaskId,
      )?.id,
      taskId,
    )
    assert.equal(
      getCoordinatorTaskIndex(layoutTasks, taskId, viewingAgentTaskId),
      rowIndex,
    )
  })
}

const viewingTopRows = getCoordinatorSessionRows({
  tasks,
  selectedIndex: 1,
  viewingAgentTaskId: 'agent-1',
  now: 5_000,
})
assertLayoutConsistency(tasks, 'agent-1', [
  'agent-1',
  'nested-child-agent',
  'nested-sibling-agent',
  'top-level-depth-one-agent',
  'workflow-1',
])
assert.deepEqual(
  viewingTopRows.map(row => ({
    id: row.id,
    depth: row.depth,
    branch: row.branch,
    viewed: row.viewed,
  })),
  [
    { id: 'main', depth: 0, branch: 'none', viewed: false },
    { id: 'agent-1', depth: 0, branch: 'none', viewed: true },
    { id: 'nested-child-agent', depth: 1, branch: 'middle', viewed: false },
    { id: 'nested-sibling-agent', depth: 1, branch: 'last', viewed: false },
    {
      id: 'top-level-depth-one-agent',
      depth: 0,
      branch: 'none',
      viewed: false,
    },
    { id: 'workflow-1', depth: 0, branch: 'none', viewed: false },
  ],
)
assert.equal(viewingTopRows[1]?.icon, '⏺')
assert.equal(viewingTopRows[1]?.primaryText, 'general-purpose')
assert.equal(viewingTopRows[1]?.secondaryText, 'Research user reports')
assert.equal(viewingTopRows[2]?.icon, '◯')
assert.equal(viewingTopRows[2]?.primaryText, 'Explore (+1)')
assert.equal(viewingTopRows[2]?.secondaryText, 'Nested child agent')
assert.equal(viewingTopRows[3]?.primaryText, 'Plan')
assert.equal(viewingTopRows[3]?.secondaryText, 'Nested sibling agent')

const selectedChildRows = getCoordinatorSessionRows({
  tasks,
  selectedIndex: 2,
  viewingAgentTaskId: 'agent-1',
  now: 5_000,
})
assert.equal(selectedChildRows[1]?.viewed, true)
assert.equal(selectedChildRows[1]?.icon, '◯')
assert.equal(selectedChildRows[2]?.selected, true)
assert.equal(selectedChildRows[2]?.icon, '⏺')

const viewedWithoutSelectionRows = getCoordinatorSessionRows({
  tasks,
  viewingAgentTaskId: 'agent-1',
  now: 5_000,
})
assert.equal(viewedWithoutSelectionRows[1]?.icon, '⏺')

const viewingChildRows = getCoordinatorSessionRows({
  tasks,
  selectedIndex: 2,
  viewingAgentTaskId: 'nested-child-agent',
  now: 5_000,
})
assertLayoutConsistency(tasks, 'nested-child-agent', [
  'agent-1',
  'nested-child-agent',
  'nested-grandchild-agent',
  'top-level-depth-one-agent',
  'workflow-1',
])
assert.deepEqual(
  viewingChildRows.slice(1, 4).map(row => ({
    id: row.id,
    depth: row.depth,
    branch: row.branch,
    selected: row.selected,
    viewed: row.viewed,
    icon: row.icon,
    primaryText: row.primaryText,
    secondaryText: row.secondaryText,
  })),
  [
    {
      id: 'agent-1',
      depth: 0,
      branch: 'none',
      selected: false,
      viewed: false,
      icon: '◯',
      primaryText: 'general-purpose (+1)',
      secondaryText: 'Research user reports',
    },
    {
      id: 'nested-child-agent',
      depth: 1,
      branch: 'last',
      selected: true,
      viewed: true,
      icon: '⏺',
      primaryText: 'Explore',
      secondaryText: 'Nested child agent',
    },
    {
      id: 'nested-grandchild-agent',
      depth: 2,
      branch: 'last',
      selected: false,
      viewed: false,
      icon: '◯',
      primaryText: 'general-purpose',
      secondaryText: 'Nested grandchild agent',
    },
  ],
)

assertLayoutConsistency(tasks, 'nested-grandchild-agent', [
  'agent-1',
  'nested-child-agent',
  'nested-grandchild-agent',
  'top-level-depth-one-agent',
  'workflow-1',
])
const viewingGrandchildRows = getCoordinatorSessionRows({
  tasks,
  selectedIndex: 3,
  viewingAgentTaskId: 'nested-grandchild-agent',
  now: 5_000,
})
assert.deepEqual(
  viewingGrandchildRows.slice(1, 4).map(row => [
    row.id,
    row.depth,
    row.branch,
    row.viewed,
  ]),
  [
    ['agent-1', 0, 'none', false],
    ['nested-child-agent', 1, 'last', false],
    ['nested-grandchild-agent', 2, 'last', true],
  ],
)

const terminalNestedTasks = {
  ...tasks,
  'nested-sibling-agent': {
    ...nestedSiblingAgentTask,
    status: 'completed',
    endTime: 4_000,
  },
  'nested-grandchild-agent': {
    ...nestedGrandchildAgentTask,
    status: 'completed',
    endTime: 4_000,
  },
} as unknown as AppState['tasks']
assertLayoutConsistency(terminalNestedTasks, 'agent-1', [
  'agent-1',
  'nested-child-agent',
  'top-level-depth-one-agent',
  'workflow-1',
])
const terminalNestedRows = getCoordinatorSessionRows({
  tasks: terminalNestedTasks,
  viewingAgentTaskId: 'agent-1',
  now: 5_000,
})
assert.equal(terminalNestedRows[1]?.primaryText, 'general-purpose')
assert.equal(terminalNestedRows[1]?.secondaryText, 'Research user reports')
assert.equal(terminalNestedRows[2]?.primaryText, 'Explore')
assert.equal(terminalNestedRows[2]?.secondaryText, 'Nested child agent')
assertLayoutConsistency(terminalNestedTasks, 'nested-grandchild-agent', [
  'agent-1',
  'top-level-depth-one-agent',
  'workflow-1',
])

const terminalTopTasks = {
  ...tasks,
  'agent-1': {
    ...agentTask,
    status: 'completed',
    endTime: 4_000,
    evictAfter: 34_000,
  },
} as unknown as AppState['tasks']
assert.equal(getVisibleAgentTasks(terminalTopTasks)[0]?.id, 'agent-1')

const cycleA = {
  ...nestedChildAgentTask,
  id: 'cycle-a',
  agentId: 'cycle-a',
  parentAgentId: 'cycle-b',
} as unknown as LocalAgentTaskState
const cycleB = {
  ...nestedChildAgentTask,
  id: 'cycle-b',
  agentId: 'cycle-b',
  parentAgentId: 'cycle-a',
} as unknown as LocalAgentTaskState
const invalidGraphTasks = {
  [agentTask.id]: agentTask,
  [orphanAgentTask.id]: orphanAgentTask,
  [cycleA.id]: cycleA,
  [cycleB.id]: cycleB,
} as unknown as AppState['tasks']
assert.deepEqual(
  getVisibleAgentTasks(invalidGraphTasks).map(task => task.id),
  ['agent-1'],
)
assert.deepEqual(
  getVisibleAgentTasks(invalidGraphTasks, 'orphan-agent').map(task => task.id),
  ['orphan-agent', 'agent-1'],
)
assert.deepEqual(
  getVisibleAgentTasks(invalidGraphTasks, 'cycle-a').map(task => task.id),
  ['cycle-a', 'agent-1'],
)

console.log('CoordinatorAgentStatus.test.ts passed')
