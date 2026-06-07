import assert from 'node:assert/strict'

import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { WorkflowTool } from '../../tools/WorkflowTool/WorkflowTool.js'
import type { AgentId } from '../../types/ids.js'
import {
  killWorkflowTask,
  pauseWorkflowTask,
  recordWorkflowAgentController,
  recordWorkflowAgentProgress,
  resumeWorkflowTask,
  retryWorkflowAgent,
  skipWorkflowAgent,
  type LocalWorkflowTaskState,
} from './LocalWorkflowTask.js'

const workflowPlan = {
  name: 'Runtime Test Workflow',
  description: 'Exercise workflow runtime state transitions.',
  defaults: {
    maxConcurrency: 2,
    maxAgents: 3,
    fanout: 1,
    concurrency: 1,
    review: 'none' as const,
    permissionMode: 'plan' as const,
  },
  phases: [
    {
      id: 'research',
      description: 'Research the target.',
      prompt: 'Research the target.',
      dependsOn: [],
      fanout: 2,
      concurrency: 2,
      review: 'none' as const,
      permissionMode: 'plan' as const,
      agentType: 'general-purpose',
    },
    {
      id: 'synthesis',
      description: 'Synthesize findings.',
      prompt: 'Synthesize findings.',
      dependsOn: ['research'],
      fanout: 1,
      concurrency: 1,
      review: 'synthesis' as const,
      permissionMode: 'plan' as const,
    },
  ],
  totalAgents: 3,
}

let state = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}

const launchedAgents: Array<{
  description: string
  prompt: string
  mode?: string
  name?: string
  team_name?: string
}> = []
const fakeAgentTool = {
  name: 'Agent',
  aliases: ['Task'],
  async call(input: {
    description: string
    prompt: string
    mode?: string
    name?: string
    team_name?: string
  }, _context: unknown, _canUseTool: unknown, _assistantMessage: unknown, onProgress?: (progress: unknown) => void) {
    launchedAgents.push({
      description: input.description,
      prompt: input.prompt,
      mode: input.mode,
      name: input.name,
      team_name: input.team_name,
    })
    for (const toolIndex of [1, 2]) {
      onProgress?.({
        toolUseID: `agent_msg_test_${toolIndex}`,
        data: {
          type: 'agent_progress',
          message: {
            type: 'assistant',
            message: {
              id: `agent_msg_test_${toolIndex}`,
              role: 'assistant',
              model: 'claude-sonnet-4-5',
              content: [{ type: 'tool_use', id: `tool_test_${toolIndex}`, name: 'Read', input: {} }],
              stop_reason: 'tool_use',
              stop_sequence: null,
              usage: {
                input_tokens: 10 + toolIndex,
                output_tokens: 2,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            },
          },
        },
      })
    }
    return {
      data: {
        status: 'completed' as const,
        prompt: input.prompt,
        content: [{ type: 'text' as const, text: `done ${input.description}` }],
        agentId: `agent-${launchedAgents.length}` as AgentId,
        totalTokens: 1,
        totalToolUseCount: 0,
        totalDurationMs: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    }
  },
}

const context = {
    getAppState: () => state,
    setAppState,
    options: {
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      tools: [fakeAgentTool],
      mcpClients: [],
      mcpResources: {},
      debug: false,
      verbose: false,
      thinkingConfig: {},
      isNonInteractiveSession: true,
      mainLoopModel: 'claude-sonnet-4-5',
    },
    abortController: new AbortController(),
    messages: [],
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext

  const result = await WorkflowTool.call(
    { action: 'run', plan: workflowPlan, runArgs: 'target: runtime' },
    context,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_test' } } as never,
  )

  assert.match(String(result.data), /Workflow launched in background\. Task ID: w/)
  assert.equal(launchedAgents.length, 3)
  assert.deepEqual(launchedAgents.map(agent => agent.description), [
    'Runtime Test Workflow: research 1/2',
    'Runtime Test Workflow: research 2/2',
    'Runtime Test Workflow: synthesis',
  ])
  assert.deepEqual(launchedAgents.map(agent => agent.mode), ['plan', 'plan', 'plan'])
  assert.match(launchedAgents[0]!.prompt, /Workflow user input:\ntarget: runtime/)
  assert.match(launchedAgents[2]!.prompt, /Upstream phase outputs/)
  assert.match(launchedAgents[2]!.prompt, /done Runtime Test Workflow: research 1\/2/)

  const workflowTasks = Object.values(state.tasks).filter(
    (task): task is LocalWorkflowTaskState => task.type === 'local_workflow',
  )
  assert.equal(workflowTasks.length, 1)
  const task = workflowTasks[0]!
  assert.equal(task.status, 'completed')
  assert.equal(task.workflowName, 'Runtime Test Workflow')
  assert.equal(task.runArgs, 'target: runtime')
  assert.equal(task.agentCount, 3)
  assert.equal(task.defaultModel, 'claude-sonnet-4-5')
  assert.equal(task.phases.length, 2)
  assert.equal(task.tokenCount, 3)
  assert.equal(task.toolUseCount, 0)
  assert.deepEqual(task.phases.map(phase => phase.status), ['completed', 'completed'])
  assert.deepEqual(task.phases.map(phase => phase.agentIds.length), [2, 1])
  assert.equal(task.results.length, 3)
  assert.equal(typeof task.progressVersion, 'number')
  assert.ok((task.progressVersion ?? 0) > 0)

  const statusResult = await WorkflowTool.call(
    { action: 'status', selector: task.id },
    context,
    async () => ({ behavior: 'allow' }),
    { message: { id: 'msg_status' } } as never,
  )
  assert.match(String(statusResult.data), /Workflow: Runtime Test Workflow/)
  assert.match(String(statusResult.data), /Status: completed/)
  assert.match(String(statusResult.data), /User input: target: runtime/)
  assert.match(String(statusResult.data), /Execution: agent/)
  assert.match(String(statusResult.data), /Progress version: \d+/)
  assert.match(String(statusResult.data), /Default model: claude-sonnet-4-5/)
  assert.match(String(statusResult.data), /Progress: \[██████████\] 3\/3 \(100%\)/)
  assert.match(String(statusResult.data), /Tokens: 3/)
  assert.match(String(statusResult.data), /Tool uses: 0/)
  assert.match(String(statusResult.data), /- research: completed 2\/2 \[██████████\] skipped 0\/2 retries: 0/)
  assert.match(String(statusResult.data), /- synthesis: completed 1\/1 \[██████████\] skipped 0\/1 retries: 0/)

  killWorkflowTask(task.id, setAppState)
  assert.equal((state.tasks[task.id] as LocalWorkflowTaskState).status, 'completed')

  const runningTask: LocalWorkflowTaskState = {
    ...task,
    id: 'w-running',
    status: 'running',
    notified: false,
    phases: [
      {
        id: 'phase',
        status: 'running',
        agentIds: ['agent-1'],
        completedAgentIds: [],
        skippedAgentIds: [],
        failedAgentIds: [],
        results: [],
      },
    ],
  }
  setAppState(prev => ({ ...prev, tasks: { ...prev.tasks, [runningTask.id]: runningTask } }))
  recordWorkflowAgentProgress({
    taskId: 'w-running',
    agentId: 'agent-1',
    tokenCount: 12,
    toolUseCount: 1,
    setAppState,
  })
  recordWorkflowAgentProgress({
    taskId: 'w-running',
    agentId: 'agent-1',
    tokenCount: 18,
    toolUseCount: 1,
    setAppState,
  })
  let progressRunningTask = state.tasks['w-running'] as LocalWorkflowTaskState
  assert.deepEqual(progressRunningTask.liveAgents?.['agent-1'], { tokenCount: 18, toolUseCount: 2 })
  assert.ok((progressRunningTask.progressVersion ?? 0) > (runningTask.progressVersion ?? 0))

  pauseWorkflowTask('w-running', setAppState)
  let pausedRunningTask = state.tasks['w-running'] as LocalWorkflowTaskState
  assert.equal(pausedRunningTask.status, 'pending')
  assert.ok(pausedRunningTask.pausedAt)
  assert.match(pausedRunningTask.summary ?? '', /Resume the paused workflow by calling: Workflow\(\{scriptPath:/)
  const pauseEvent = pausedRunningTask.events.at(-1)
  assert.equal(pauseEvent?.type, 'workflow_progress')
  if (pauseEvent?.type === 'workflow_progress') {
    assert.equal(pauseEvent.status, 'paused')
  }

  resumeWorkflowTask('w-running', setAppState)
  pausedRunningTask = state.tasks['w-running'] as LocalWorkflowTaskState
  assert.equal(pausedRunningTask.status, 'running')
  assert.equal(pausedRunningTask.pausedAt, undefined)
  assert.ok((pausedRunningTask.totalPausedMs ?? 0) >= 0)

  const agentAbortController = new AbortController()
  recordWorkflowAgentController({
    taskId: 'w-running',
    agentId: 'agent-1',
    abortController: agentAbortController,
    setAppState,
  })
  skipWorkflowAgent('w-running', 'agent-1', setAppState)
  assert.equal(agentAbortController.signal.aborted, true)
  let updatedRunningTask = state.tasks['w-running'] as LocalWorkflowTaskState
  assert.deepEqual(updatedRunningTask.phases[0]!.skippedAgentIds, ['agent-1'])
  assert.deepEqual(updatedRunningTask.phases[0]!.completedAgentIds, ['agent-1'])
  const skipEvent = updatedRunningTask.events.at(-1)
  assert.equal(skipEvent?.type, 'workflow_agent')
  if (skipEvent?.type === 'workflow_agent') {
    assert.equal(skipEvent.status, 'skipped')
  }

  retryWorkflowAgent('w-running', 'agent-1', setAppState)
  updatedRunningTask = state.tasks['w-running'] as LocalWorkflowTaskState
  assert.deepEqual(updatedRunningTask.phases[0]!.skippedAgentIds, [])
  assert.deepEqual(updatedRunningTask.phases[0]!.completedAgentIds, [])
  assert.deepEqual(updatedRunningTask.phases[0]!.agentIds, ['agent-1 (retry 1)'])
  assert.equal(updatedRunningTask.currentAgentId, 'agent-1 (retry 1)')
  const retryEvent = updatedRunningTask.events.at(-1)
  assert.equal(retryEvent?.type, 'workflow_agent')
  if (retryEvent?.type === 'workflow_agent') {
    assert.equal(retryEvent.status, 'running')
  }

let retryState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setRetryState = (updater: (prev: AppState) => AppState): void => {
  retryState = updater(retryState)
}
const retryAttempts: string[] = []
const retryAgentTool = {
  name: 'Agent',
  aliases: ['Task'],
  async call(input: { description: string; prompt: string; mode?: string }) {
    retryAttempts.push(input.description)
    if (retryAttempts.length === 1) {
      throw new Error('temporary failure')
    }
    return {
      data: {
        status: 'completed' as const,
        prompt: input.prompt,
        content: [{ type: 'text' as const, text: 'retry succeeded' }],
        agentId: `retry-agent-${retryAttempts.length}` as AgentId,
      },
    }
  },
}
const retryContext = {
  ...context,
  getAppState: () => retryState,
  setAppState: setRetryState,
  options: {
    ...context.options,
    tools: [retryAgentTool],
  },
} as unknown as ToolUseContext
const retryPlan = {
  ...workflowPlan,
  name: 'Retry Workflow',
  defaults: {
    ...workflowPlan.defaults,
    maxRetries: 1,
  },
  phases: [
    {
      ...workflowPlan.phases[0]!,
      id: 'unstable',
      description: 'Retry unstable work.',
      prompt: 'Retry unstable work.',
      fanout: 1,
      concurrency: 1,
    },
  ],
  totalAgents: 1,
}
const retryResult = await WorkflowTool.call(
  { action: 'run', plan: retryPlan },
  retryContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_retry' } } as never,
)
assert.match(String(retryResult.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(retryAttempts, [
  'Retry Workflow: unstable',
  'Retry Workflow: unstable retry 1/1',
])
const retryTask = Object.values(retryState.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow',
)!
assert.equal(retryTask.status, 'completed')
assert.equal(retryTask.results.length, 1)
assert.equal(retryTask.phases[0]!.failedAgentIds.length, 0)

let manualRetryState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
} as unknown as AppState
const setManualRetryState = (updater: (prev: AppState) => AppState): void => {
  manualRetryState = updater(manualRetryState)
}
const manualRetryAttempts: string[] = []
let manualRetryFirstAbortReason: unknown
const manualRetryAgentTool = {
  name: 'Agent',
  aliases: ['Task'],
  async call(input: { description: string; prompt: string; mode?: string }, callContext: { abortController: AbortController }) {
    manualRetryAttempts.push(input.description)
    if (manualRetryAttempts.length === 1) {
      setTimeout(() => {
        const running = Object.values(manualRetryState.tasks).find(
          (task): task is LocalWorkflowTaskState => task.type === 'local_workflow',
        )!
        retryWorkflowAgent(running.id, 'unstable', setManualRetryState)
      }, 0)
      return await new Promise<never>((_resolve, reject) => {
        callContext.abortController.signal.addEventListener('abort', () => {
          manualRetryFirstAbortReason = callContext.abortController.signal.reason
          reject(new Error('manual retry abort'))
        }, { once: true })
      })
    }
    return {
      data: {
        status: 'completed' as const,
        prompt: input.prompt,
        content: [{ type: 'text' as const, text: 'manual retry succeeded' }],
      },
    }
  },
}
const manualRetryContext = {
  ...context,
  getAppState: () => manualRetryState,
  setAppState: setManualRetryState,
  options: {
    ...context.options,
    tools: [manualRetryAgentTool],
  },
} as unknown as ToolUseContext
const manualRetryResult = await WorkflowTool.call(
  {
    action: 'run',
    plan: {
      ...workflowPlan,
      name: 'Manual Retry Workflow',
      phases: [
        {
          ...workflowPlan.phases[0]!,
          id: 'unstable',
          displayName: 'unstable',
          description: 'Retry unstable work by user request.',
          prompt: 'Retry unstable work by user request.',
          fanout: 1,
          concurrency: 1,
        },
      ],
      totalAgents: 1,
    },
  },
  manualRetryContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_manual_retry' } } as never,
)
assert.match(String(manualRetryResult.data), /Workflow launched in background\. Task ID: w/)
assert.deepEqual(manualRetryAttempts, [
  'Manual Retry Workflow: unstable',
  'Manual Retry Workflow: unstable retry 1',
])
assert.equal(manualRetryFirstAbortReason, 'workflow-agent-user-retry')
const manualRetryTask = Object.values(manualRetryState.tasks).find(
  (task): task is LocalWorkflowTaskState => task.type === 'local_workflow',
)!
assert.equal(manualRetryTask.status, 'completed')
assert.equal(manualRetryTask.results.length, 1)
assert.equal(manualRetryTask.results[0]!.agentId, 'unstable (retry 1)')
assert.deepEqual(manualRetryTask.phases[0]!.completedAgentIds, ['unstable (retry 1)'])
assert.equal(manualRetryTask.phases[0]!.failedAgentIds.length, 0)

let teamState = {
  tasks: {},
  toolPermissionContext: { mode: 'default' },
  teamContext: { teamName: 'workflow-team' },
} as unknown as AppState
const setTeamState = (updater: (prev: AppState) => AppState): void => {
  teamState = updater(teamState)
}
const teamAgents: Array<{ name?: string; team_name?: string; description: string }> = []
const teamAgentTool = {
  name: 'Agent',
  aliases: ['Task'],
  async call(input: { description: string; prompt: string; name?: string; team_name?: string }) {
    teamAgents.push({
      description: input.description,
      name: input.name,
      team_name: input.team_name,
    })
    return {
      data: {
        status: 'completed' as const,
        prompt: input.prompt,
        content: [{ type: 'text' as const, text: 'team worker done' }],
        agentId: `team-agent-${teamAgents.length}` as AgentId,
      },
    }
  },
}
const teamContext = {
  ...context,
  getAppState: () => teamState,
  setAppState: setTeamState,
  options: {
    ...context.options,
    tools: [teamAgentTool],
  },
} as unknown as ToolUseContext
const teamResult = await WorkflowTool.call(
  {
    action: 'run',
    plan: {
      ...workflowPlan,
      name: 'Team Workflow',
      defaults: {
        ...workflowPlan.defaults,
        execution: 'team' as const,
      },
      phases: [
        {
          ...workflowPlan.phases[0]!,
          fanout: 2,
          concurrency: 2,
        },
      ],
      totalAgents: 2,
    },
  },
  teamContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_team' } } as never,
)
assert.deepEqual(teamAgents.map(agent => agent.team_name), [
  'workflow-team',
  'workflow-team',
])
assert.deepEqual(teamAgents.map(agent => agent.name), [
  'team-workflow-research-1',
  'team-workflow-research-2',
])
const teamTaskId = String(teamResult.data).match(/Task ID: (\S+)/)?.[1]
assert.ok(teamTaskId)
const teamStatusResult = await WorkflowTool.call(
  { action: 'status', selector: teamTaskId },
  teamContext,
  async () => ({ behavior: 'allow' }),
  { message: { id: 'msg_team_status' } } as never,
)
assert.match(String(teamStatusResult.data), /Execution: team/)
assert.match(String(teamStatusResult.data), /Team: workflow-team/)
assert.match(String(teamStatusResult.data), /tmux-backed agents: named team workers/)
assert.match(String(teamStatusResult.data), /Progress: \[██████████\] 2\/2 \(100%\)/)

console.log('LocalWorkflowTask.test.ts passed')
