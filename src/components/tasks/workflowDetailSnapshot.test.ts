import assert from 'node:assert/strict'

import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatWorkflowDetailSnapshot } from './workflowDetailSnapshot.js'

const workflow: LocalWorkflowTaskState = {
  id: 'w-ui',
  type: 'local_workflow',
  status: 'running',
  description: 'Workflow: UI Alignment Workflow',
  workflowName: 'UI Alignment Workflow',
  workflowRunId: 'wf_ui',
  scriptPath: '/tmp/ui-workflow.js',
  summary: 'Official-style running workflow detail.',
  defaultModel: 'gpt-5.5[1m]',
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

assert.equal(
  formatWorkflowDetailSnapshot(workflow),
  `UI Alignment Workflow
Official-style running workflow detail.                                                    1/2 agents · 2500ms

╭ Phases ────────┬ scan · 2 agents ─────────────────────────────────────────────────────────────────────────────╮
│ ❯ 1 scan   1/2  │  ⏺ scan-a                   gpt-5.5[1m]    0 tok · 0 tools                                 │
│                 │  ⏺ scan-b                   gpt-5.5[1m]    0 tok · 0 tools                                 │
╰────────────────┴────────────────────────────────────────────────────────────────────────────────────────────╯

Recent events
- workflow_progress running 1/2
- workflow_agent scan-a completed cache hit

↑↓ select · x stop workflow · p pause · esc back · s save`,
)

console.log('workflowDetailSnapshot.test.ts passed')
