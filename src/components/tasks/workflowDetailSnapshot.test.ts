import assert from 'node:assert/strict'

import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  initialSelectedWorkflowAgentIndex,
  workflowDetailSnapshotLines,
} from './workflowDetailSnapshot.js'

const workflow: LocalWorkflowTaskState = {
  id: 'w-ui',
  type: 'local_workflow',
  status: 'running',
  description: 'Workflow: UI Alignment Workflow',
  workflowName: 'UI Alignment Workflow',
  workflowRunId: 'wf_ui',
  scriptPath: '/tmp/ui-workflow.js',
  summary: 'Workflow started',
  defaultModel: 'gpt-5.5[1m]',
  meta: {
    name: 'UI Alignment Workflow',
    description: 'Official-style running workflow detail.',
    phases: [{ title: 'scan', detail: 'Scan UI state.' }],
  },
  runArgs: { topic: 'ui' },
  agentCount: 2,
  tokenCount: 12,
  toolUseCount: 3,
  execution: 'agent',
  runtime: { kind: 'javascript-worker', sourcePath: '/tmp/ui-workflow.js', isolated: true },
  sourcePath: '/tmp/ui-workflow.js',
  runScriptSnapshot: 'export const meta = {}',
  startTime: 1_000,
  endTime: 3_500,
  outputFile: '.claude/tasks/w-ui.output',
  outputOffset: 0,
  notified: false,
  phases: [
    {
      id: 'scan',
      status: 'running',
      agentIds: ['scan-a', 'scan-b'],
      completedAgentIds: ['scan-a'],
      skippedAgentIds: [],
      failedAgentIds: ['scan-b'],
      results: [
        {
          phaseId: 'scan',
          agentId: 'scan-a',
          index: 0,
          status: 'completed',
          output: 'found files',
        },
      ],
    },
  ],
  results: [
    {
      phaseId: 'scan',
      agentId: 'scan-a',
      index: 0,
      status: 'completed',
      output: 'found files',
    },
  ],
  events: [
    {
      type: 'workflow_progress',
      workflowRunId: 'wf_ui',
      status: 'running',
      completedAgents: 1,
      totalAgents: 2,
      timestamp: 10,
    },
    {
      type: 'workflow_agent',
      workflowRunId: 'wf_ui',
      phaseId: 'scan',
      agentId: 'scan-a',
      status: 'completed',
      cacheHit: true,
      timestamp: 11,
    },
  ],
}

const phaseSelectedLines = workflowDetailSnapshotLines(workflow)
assert.equal(phaseSelectedLines[0], 'UI Alignment Workflow')
assert.equal(phaseSelectedLines[1], 'Official-style running workflow detail.                                                        1/2 agents · 2s')
assert.equal(phaseSelectedLines[3], '╭ Phases ────────┬ scan · 2 agents ─────────────────────────────────────────────────────────────────────────────╮')
assert.equal(phaseSelectedLines[4], '│ ❯ 1 scan   1/2  │  ⏺ scan-a                   gpt-5.5[1m]    0 tok · 0 tools                                 │')
assert.equal(phaseSelectedLines[5], '│                 │  ⏺ scan-b                   gpt-5.5[1m]    0 tok · 0 tools                                 │')
assert.equal(phaseSelectedLines[6], '╰────────────────┴────────────────────────────────────────────────────────────────────────────────────────────╯')
assert.equal(phaseSelectedLines[8], '↑↓ select · x stop workflow · p pause · esc back · s save')

const agentSelectedLines = workflowDetailSnapshotLines(workflow, { selectedAgentId: 'scan-b' })
assert.equal(agentSelectedLines[3], '╭ Phases ────────┬ scan · 2 agents ─────────────────────────────────────────────────────────────────────────────╮')
assert.equal(agentSelectedLines[4], '│   1 scan   1/2  │  ⏺ scan-a                   gpt-5.5[1m]    0 tok · 0 tools                                 │')
assert.equal(agentSelectedLines[5], '│                 │ ❯⏺ scan-b                   gpt-5.5[1m]    0 tok · 0 tools                                │')
assert.equal(agentSelectedLines[6], '╰────────────────┴────────────────────────────────────────────────────────────────────────────────────────────╯')
assert.equal(agentSelectedLines[8], '↑↓ select · x stop · r restart · p pause · esc back · s save')

const agentDetailLines = workflowDetailSnapshotLines(workflow, { selectedAgentId: 'scan-b', showAgentDetail: true })
assert.equal(agentDetailLines[3], '╭ scan · 2 agents┬ scan-b ─────────────────────────────────────────────────────────────────────────────────────╮')
assert.equal(agentDetailLines[4], '│   ⏺ scan-a     │ ⏺ Running · gpt-5.5[1m]                                                                    │')
assert.equal(agentDetailLines[5], '│ ❯ ⏺ scan-b    │ 0 tok · 0 tool calls                                                                       │')
assert.equal(agentDetailLines[7], '│                │ Prompt                                                                                     │')
assert.equal(agentDetailLines[8], '│                │   Scan UI state.                                                                           │')
assert.equal(agentDetailLines[10], '│                │ Activity                                                                                   │')
assert.equal(agentDetailLines[11], '│                │   Still running…                                                                           │')
assert.equal(agentDetailLines[13], '│                │ Outcome                                                                                    │')
assert.equal(agentDetailLines[14], '│                │   Still running…                                                                           │')
assert.equal(agentDetailLines.at(-3), '╰────────────────┴────────────────────────────────────────────────────────────────────────────────────────────╯')
assert.equal(agentDetailLines.at(-1), '↑↓ agent · x stop · r restart · p pause · esc back · s save')

const retryDetailLines = workflowDetailSnapshotLines({
  ...workflow,
  phases: [
    {
      ...workflow.phases[0]!,
      agentIds: ['scan-b (retry 1)'],
      completedAgentIds: [],
      failedAgentIds: [],
      results: [
        {
          phaseId: 'scan',
          agentId: 'scan-b (retry 1)',
          index: 1,
          status: 'running',
        },
      ],
    },
  ],
}, { selectedAgentId: 'scan-b (retry 1)', showAgentDetail: true })
assert.equal(retryDetailLines[4], '│ ❯ ⏺ scan-b (retry 1)│ ⏺ Running · gpt-5.5[1m] · attempt 2 (user retry)                                      │')
assert.equal(retryDetailLines[13], '│                     │ Outcome                                                                               │')
assert.equal(retryDetailLines[14], '│                     │   Still running…                                                                      │')

const liveProgressWorkflow: LocalWorkflowTaskState = {
  ...workflow,
  liveAgents: {
    'scan-b': {
      tokenCount: 12,
      toolUseCount: 2,
      prompt: 'Investigate UI rendering drift.',
      activity: 'Bash(sleep 20)',
      recentActivities: ['Skill(superpowers:using-superpowers)', 'Bash(sleep 20)'],
    },
  },
}
const liveProgressLines = workflowDetailSnapshotLines(liveProgressWorkflow, { selectedAgentId: 'scan-b' })
assert.equal(liveProgressLines[5], '│                 │ ❯⏺ scan-b                   gpt-5.5[1m]    12 tok · 2 tools                                │')
const liveAgentDetailLines = workflowDetailSnapshotLines(liveProgressWorkflow, { selectedAgentId: 'scan-b', showAgentDetail: true })
assert.equal(liveAgentDetailLines[8], '│                │   Investigate UI rendering drift.                                                          │')
assert.equal(liveAgentDetailLines[11], '│                │   Skill(superpowers:using-superpowers)                                                     │')
assert.equal(liveAgentDetailLines[12], '│                │   Bash(sleep 20)                                                                           │')

const runtimeAgentIdLines = workflowDetailSnapshotLines({
  ...workflow,
  phases: [
    {
      ...workflow.phases[0]!,
      agentIds: ['display-agent'],
      completedAgentIds: ['display-agent'],
      results: [
        {
          phaseId: 'scan',
          agentId: 'runtime-agent-id',
          index: 0,
          status: 'completed',
          output: 'done',
          tokenCount: 19687,
          toolUseCount: 0,
        },
      ],
    },
  ],
  results: [
    {
      phaseId: 'scan',
      agentId: 'runtime-agent-id',
      index: 0,
      status: 'completed',
      output: 'done',
      tokenCount: 19687,
      toolUseCount: 0,
    },
  ],
}, { selectedAgentId: 'display-agent' })
assert.equal(runtimeAgentIdLines[4], '│   1 scan   1/1  │ ❯⏺ display-agent            gpt-5.5[1m]    19687 tok · 0 tools                             │')

const pausedLines = workflowDetailSnapshotLines({ ...workflow, status: 'pending' }, { selectedAgentId: 'scan-b', showAgentDetail: true })
assert.equal(pausedLines[1], 'Official-style running workflow detail.                                               1/2 agents · 2s · paused')
assert.equal(pausedLines[4], '│   ◌ scan-a     │ ◌ Stopped · gpt-5.5[1m]                                                                    │')
assert.equal(pausedLines[5], '│ ❯ ◌ scan-b     │ 0 tok · 0 tool calls                                                                       │')
assert.equal(pausedLines[14], '│                │   The workflow stopped before this agent finished.                                         │')
assert.equal(pausedLines.at(-1), '↑↓ agent · p resume · esc back · s save')

assert.equal(
  workflowDetailSnapshotLines({ ...workflow, status: 'pending' }).at(-1),
  '↑↓ select · p resume · esc back · s save',
)

const stagedLines = workflowDetailSnapshotLines({
  ...workflow,
  agentCount: 4,
  phases: [
    {
      id: 'Fanout',
      status: 'running',
      agentIds: ['fanout-1', 'fanout-2', 'fanout-3'],
      completedAgentIds: [],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
    {
      id: 'After',
      status: 'pending',
      agentIds: [],
      completedAgentIds: [],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [],
    },
  ],
})
assert.equal(stagedLines[1], 'Official-style running workflow detail.                                                        0/3 agents · 2s')

assert.equal(initialSelectedWorkflowAgentIndex(workflow), 0)
assert.equal(initialSelectedWorkflowAgentIndex({ ...workflow, status: 'pending' }), null)
assert.equal(initialSelectedWorkflowAgentIndex({ ...workflow, phases: [{ ...workflow.phases[0]!, agentIds: [] }] }), null)

console.log('workflowDetailSnapshot.test.ts passed')
