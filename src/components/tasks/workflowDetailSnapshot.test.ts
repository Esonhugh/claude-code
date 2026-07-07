import assert from 'node:assert/strict'

import { stringWidth } from '../../ink/stringWidth.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  initialSelectedWorkflowAgentIndex,
  workflowDetailSnapshotLines,
} from './workflowDetailSnapshot.js'
import { workflowDetailAgentStatus } from './workflowDetailModel.js'

function normalizeSnapshotLine(line: string | undefined): string | undefined {
  return line?.trimEnd().replace(/\s+│$/u, '│')
}

function assertLine(actual: string | undefined, expected: string): void {
  assert.equal(normalizeSnapshotLine(actual), normalizeSnapshotLine(expected))
}

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
assertLine(phaseSelectedLines[0], 'UI Alignment Workflow')
assertLine(phaseSelectedLines[1], 'Official-style running workflow detail.                                                        1/2 agents · 2s')
assertLine(phaseSelectedLines[3], '╭ Phases ────────┬ scan · 2 agents ─────────────────────────────────────────────────────────────────────────────╮')
assertLine(phaseSelectedLines[4], '│ ❯ 1 scan   1/2  │  ⏺ scan-a                   gpt-5.5[1m]    0 tok · 0 tools                                 │')
assertLine(phaseSelectedLines[5], '│                 │  ⏺ scan-b                   gpt-5.5[1m]    0 tok · 0 tools                                 │')
assertLine(phaseSelectedLines[6], '╰────────────────┴────────────────────────────────────────────────────────────────────────────────────────────╯')
assertLine(phaseSelectedLines[8], '↑↓ select · x stop workflow · p pause · esc back · s save')

const agentSelectedLines = workflowDetailSnapshotLines(workflow, { selectedAgentId: 'scan-b' })
assertLine(agentSelectedLines[3], '╭ Phases ────────┬ scan · 2 agents ─────────────────────────────────────────────────────────────────────────────╮')
assertLine(agentSelectedLines[4], '│   1 scan   1/2  │  ⏺ scan-a                   gpt-5.5[1m]    0 tok · 0 tools                                 │')
assertLine(agentSelectedLines[5], '│                 │ ❯⏺ scan-b                   gpt-5.5[1m]    0 tok · 0 tools                                 │')
assertLine(agentSelectedLines[6], '╰────────────────┴────────────────────────────────────────────────────────────────────────────────────────────╯')
assertLine(agentSelectedLines[8], '↑↓ select · x stop · r restart · p pause · esc back · s save')

const agentDetailLines = workflowDetailSnapshotLines(workflow, { selectedAgentId: 'scan-b', showAgentDetail: true })
assertLine(agentDetailLines[3], '╭ scan · 2 agents┬ scan-b ─────────────────────────────────────────────────────────────────────────────────────╮')
assertLine(agentDetailLines[4], '│   ⏺ scan-a     │ ⏺ Running · gpt-5.5[1m]                                                                    │')
assertLine(agentDetailLines[5], '│ ❯ ⏺ scan-b     │ 0 tok · 0 tool calls                                                                       │')
assertLine(agentDetailLines[7], '│                │ Prompt                                                                                     │')
assertLine(agentDetailLines[8], '│                │   Scan UI state.                                                                           │')
assertLine(agentDetailLines[10], '│                │ Activity                                                                                   │')
assertLine(agentDetailLines[11], '│                │   Still running…                                                                           │')
assertLine(agentDetailLines[13], '│                │ Outcome                                                                                    │')
assertLine(agentDetailLines[14], '│                │   Waiting for an agent slot.                                                                           │')
assertLine(agentDetailLines.at(-3), '╰────────────────┴────────────────────────────────────────────────────────────────────────────────────────────╯')
assertLine(agentDetailLines.at(-1), '↑↓ agent · x stop · r restart · p pause · esc back · s save')

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
assertLine(retryDetailLines[4], '│ ❯ ⏺ scan-b (retry 1)│ ⏺ Running · gpt-5.5[1m] · attempt 2 (user retry)                                      │')
assert.ok(retryDetailLines[13]?.includes('Outcome'), retryDetailLines.join('\n'))
assert.ok(retryDetailLines[14]?.includes('Waiting for an agent slot.'), retryDetailLines.join('\n'))

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
assertLine(liveProgressLines[5], '│                 │ ❯⏺ scan-b                   gpt-5.5[1m]    12 tok · 2 tools                               │')
const liveAgentDetailLines = workflowDetailSnapshotLines(liveProgressWorkflow, { selectedAgentId: 'scan-b', showAgentDetail: true })
assertLine(liveAgentDetailLines[8], '│                │   Investigate UI rendering drift.                                                          │')
assertLine(liveAgentDetailLines[11], '│                │   Skill(superpowers:using-superpowers)                                                     │')
assertLine(liveAgentDetailLines[12], '│                │   Bash(sleep 20)                                                                           │')

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
assertLine(runtimeAgentIdLines[4], '│   1 scan   1/1  │ ❯⏺ display-agent            gpt-5.5[1m]    19687 tok · 0 tools                            │')

const pausedLines = workflowDetailSnapshotLines({ ...workflow, status: 'pending' }, { selectedAgentId: 'scan-b', showAgentDetail: true })
assertLine(pausedLines[1], 'Official-style running workflow detail.                                               1/2 agents · 2s · paused')
assertLine(pausedLines[4], '│   ✓ scan-a     │ ◌ Stopped · gpt-5.5[1m]                                                                    │')
assertLine(pausedLines[5], '│ ❯ ◌ scan-b     │ 0 tok · 0 tool calls                                                                       │')
assertLine(pausedLines[14], '│                │   The workflow stopped before this agent finished.                                         │')
assertLine(pausedLines.at(-1), '↑↓ agent · p resume · esc back · s save')

assert.equal(
  workflowDetailSnapshotLines({ ...workflow, status: 'pending' }).at(-1),
  '↑↓ select · p resume · esc back · s save',
)

const killedLines = workflowDetailSnapshotLines({ ...workflow, status: 'killed' }, { selectedAgentId: 'scan-b', showAgentDetail: true })
assertLine(killedLines[1], 'Official-style running workflow detail.                                               1/2 agents · 2s · killed')
assertLine(killedLines[4], '│   ✓ scan-a     │ ◌ Stopped · gpt-5.5[1m]                                                                    │')
assertLine(killedLines[14], '│                │   The workflow stopped before this agent finished.                                         │')

const staleLiveAgentKilledWorkflow: LocalWorkflowTaskState = {
  ...workflow,
  status: 'killed',
  liveAgents: {
    'scan-b': { tokenCount: 5, toolUseCount: 1, activity: 'Bash(sleep 20)' },
  },
}
assert.equal(workflowDetailAgentStatus(staleLiveAgentKilledWorkflow, 'scan-b'), 'interrupted')
assertLine(
  workflowDetailSnapshotLines(staleLiveAgentKilledWorkflow, { selectedAgentId: 'scan-b', showAgentDetail: true })[4],
  '│   ✓ scan-a     │ ◌ Stopped · gpt-5.5[1m]                                                                    │',
)

const killedFailedLines = workflowDetailSnapshotLines({
  ...workflow,
  status: 'killed',
  phases: [
    {
      ...workflow.phases[0]!,
      completedAgentIds: ['scan-a', 'scan-b'],
      results: [
        ...workflow.phases[0]!.results,
        { phaseId: 'scan', agentId: 'scan-b', index: 1, status: 'failed', error: 'boom' },
      ],
    },
  ],
  results: [
    ...workflow.results,
    { phaseId: 'scan', agentId: 'scan-b', index: 1, status: 'failed', error: 'boom' },
  ],
}, { selectedAgentId: 'scan-b', showAgentDetail: true })
assertLine(killedFailedLines[5], '│ ❯ ✗ scan-b     │ 0 tok · 0 tool calls                                                                       │')
assertLine(killedFailedLines[14], '│                │   boom                                                                                     │')

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
assertLine(stagedLines[1], 'Official-style running workflow detail.                                                        0/4 agents · 2s')

const officialParentWorkflow: LocalWorkflowTaskState = {
  ...workflow,
  status: 'completed',
  workflowName: 'tmux-official-parent',
  description: 'Workflow: tmux-official-parent',
  summary: 'Workflow completed',
  meta: {
    name: 'tmux-official-parent',
    description: 'tmux official parent workflow',
    phases: [{ title: 'Parent', detail: 'Run child workflow then parent agent' }],
  },
  agentCount: 2,
  phases: [
    {
      id: 'Parent',
      status: 'completed',
      agentIds: ['child-agent'],
      completedAgentIds: ['child-agent'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [
        {
          phaseId: 'Parent',
          agentId: 'child-agent',
          index: 0,
          status: 'completed',
          output: 'official child ok',
        },
      ],
    },
    {
      id: 'parent-agent',
      status: 'completed',
      agentIds: ['parent-agent'],
      completedAgentIds: ['parent-agent'],
      skippedAgentIds: [],
      failedAgentIds: [],
      results: [
        {
          phaseId: 'parent-agent',
          agentId: 'parent-agent',
          index: 0,
          status: 'completed',
          output: 'official parent ok',
        },
      ],
    },
  ],
  results: [],
}
const officialParentLines = workflowDetailSnapshotLines(officialParentWorkflow)
assert.ok(officialParentLines.some(line => line.includes('2 parent-agen')), officialParentLines.join('\n'))
const officialParentSelectedLines = workflowDetailSnapshotLines(officialParentWorkflow, { selectedAgentId: 'parent-agent' })
assert.ok(officialParentSelectedLines.some(line => line.includes('parent-agent') && line.includes('0 tok · 0 tools')), officialParentSelectedLines.join('\n'))
const officialParentAgentLines = workflowDetailSnapshotLines(officialParentWorkflow, { selectedAgentId: 'parent-agent', showAgentDetail: true })
assert.ok(officialParentAgentLines.some(line => line.includes('parent-agent ·')), officialParentAgentLines.join('\n'))
assert.ok(officialParentAgentLines.some(line => line.includes('official parent ok')), officialParentAgentLines.join('\n'))

const officialParentDescriptionLines = workflowDetailSnapshotLines({
  ...officialParentWorkflow,
  meta: undefined,
  summary: 'Workflow completed',
  description: 'Official parent description from task_started',
})
assert.ok(officialParentDescriptionLines[1]?.includes('Official parent description from task_started'), officialParentDescriptionLines.join('\n'))
assert.ok(officialParentDescriptionLines[1]?.includes('2/2 agents · 2s · done'), officialParentDescriptionLines.join('\n'))

const completedPromptLines = workflowDetailSnapshotLines({
  ...workflow,
  status: 'completed',
  liveAgents: undefined,
  phases: [
    {
      ...workflow.phases[0]!,
      agentIds: ['scan-a'],
      completedAgentIds: ['scan-a'],
      results: [
        {
          phaseId: 'scan',
          agentId: 'scan-a',
          index: 0,
          status: 'completed',
          prompt: 'Saved result prompt.',
          output: 'saved output',
        },
      ],
    },
  ],
  results: [],
}, { selectedAgentId: 'scan-a', showAgentDetail: true })
assert.ok(completedPromptLines.some(line => line.includes('Saved result prompt.')), completedPromptLines.join('\n'))

const longOutcomeLines = workflowDetailSnapshotLines({
  ...workflow,
  status: 'completed',
  liveAgents: undefined,
  phases: [
    {
      ...workflow.phases[0]!,
      agentIds: ['scan-a'],
      completedAgentIds: ['scan-a'],
      results: [
        {
          phaseId: 'scan',
          agentId: 'scan-a',
          index: 0,
          status: 'completed',
          output: `start ${'x'.repeat(140)} 宽字符结尾\r\n\u001b[32mgreen line\u001b[0m`,
        },
      ],
    },
  ],
  results: [],
}, { selectedAgentId: 'scan-a', showAgentDetail: true })
assert.ok(longOutcomeLines.some(line => line.includes('start x')), longOutcomeLines.join('\n'))
assert.ok(longOutcomeLines.some(line => line.includes('宽字符结尾')), longOutcomeLines.join('\n'))
assert.ok(longOutcomeLines.some(line => line.includes('green line')), longOutcomeLines.join('\n'))
assert.ok(!longOutcomeLines.join('\n').includes('\u001b'), longOutcomeLines.join('\n'))
const longOutcomePanelWidth = stringWidth(longOutcomeLines[3]!)
for (const line of longOutcomeLines.slice(3, -2)) {
  assert.equal(stringWidth(line), longOutcomePanelWidth, line)
}

assert.equal(initialSelectedWorkflowAgentIndex(workflow), 0)
assert.equal(initialSelectedWorkflowAgentIndex({ ...workflow, status: 'pending' }), null)
assert.equal(initialSelectedWorkflowAgentIndex({ ...workflow, phases: [{ ...workflow.phases[0]!, agentIds: [] }] }), null)

console.log('workflowDetailSnapshot.test.ts passed')
