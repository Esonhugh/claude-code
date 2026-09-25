import assert from 'node:assert/strict'
import { mock, test } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { GENERAL_PURPOSE_AGENT } from '../../tools/AgentTool/built-in/generalPurposeAgent.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import { createUserMessage } from '../messages.js'
import { canEvictTerminalTask } from '../task/retention.js'
import { dismissTerminalAgent, enterTeammateView, exitTeammateView } from '../../state/teammateViewHelpers.js'
import {
  getSystemPromptSections,
  withSystemPromptSections,
  type SystemPrompt,
} from '../systemPromptType.js'
import { TEAMMATE_SYSTEM_PROMPT_ADDENDUM } from './teammatePromptAddendum.js'

let runAgentMode: 'complete' | 'fail' = 'complete'
let lifecycleAbortController: AbortController | undefined
let observedResolvedModel: string | undefined
let observedTools: string[] = []
let observedSystemPrompt: SystemPrompt | undefined
let observedOverrides: Array<{
  abortController?: AbortController
  agentId?: ReturnType<typeof asAgentId>
}> = []
let queuedFollowUp: { taskId: string; message: string } | undefined
let currentSetState:
  | ((updater: (prev: ReturnType<typeof createState>) => ReturnType<typeof createState>) => void)
  | undefined

mock.module('../../constants/prompts.js', () => ({
  getSystemPrompt: async () =>
    withSystemPromptSections([
      { name: 'identity', text: 'CORE_IDENTITY' },
      { name: 'language', text: null },
    ]),
}))
mock.module('../../tools/AgentTool/runAgent.js', () => ({
  async *runAgent(params: {
    resolvedModel?: string
    baseSystemPrompt: SystemPrompt
    agentDefinition: AgentDefinition
    availableTools: Tools
    override?: {
      abortController?: AbortController
      agentId?: ReturnType<typeof asAgentId>
    }
  }) {
    observedResolvedModel = params.resolvedModel
    observedSystemPrompt = params.baseSystemPrompt
    observedOverrides.push(params.override ?? {})
    const { resolveAgentTools } = await import('../../tools/AgentTool/agentToolUtils.js')
    observedTools = resolveAgentTools(params.agentDefinition, params.availableTools, true)
      .resolvedTools.map(tool => tool.name)
    if (runAgentMode === 'fail') {
      throw new Error('runner boom')
    }
    const hasFollowUp = queuedFollowUp !== undefined
    if (queuedFollowUp) {
      const { taskId, message } = queuedFollowUp
      queuedFollowUp = undefined
      params.override?.abortController?.abort()
      currentSetState?.(prev => {
        const task = prev.tasks[taskId]
        if (!task || task.type !== 'in_process_teammate') return prev
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: {
              ...task,
              pendingUserMessages: [...task.pendingUserMessages, message],
            },
          },
        }
      })
    }
    yield {
      type: 'assistant',
      uuid: crypto.randomUUID(),
      requestId: 'req_in_process_retention_test',
      message: {
        id: 'msg_in_process_retention_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
          service_tier: 'standard',
          cache_creation: null,
        },
      },
    }
    if (!hasFollowUp) {
      lifecycleAbortController?.abort()
    }
  },
}))
mock.module('../task/framework.js', () => ({
  STOPPED_DISPLAY_MS: 0,
  PANEL_GRACE_MS: 30_000,
  evictTerminalTask: () => {},
  registerTask: (task: { id: string }, setAppState: (updater: (prev: ReturnType<typeof getDefaultAppState>) => ReturnType<typeof getDefaultAppState>) => void) => {
    setAppState(prev => ({
      ...prev,
      tasks: {
        ...prev.tasks,
        [task.id]: task as never,
      },
    }))
  },
}))
mock.module('../task/diskOutput.js', () => ({
  evictTaskOutput: async () => {},
}))
mock.module('../sdkEventQueue.js', () => ({
  emitTaskTerminatedSdk: () => {},
}))
mock.module('./teamHelpers.js', () => ({
  removeMemberByAgentId: () => {},
}))

const { spawnInProcessTeammate, killInProcessTeammate } = await import('./spawnInProcess.js')
const { runInProcessTeammate } = await import('./inProcessRunner.js')
const { isViewableTeammate } = await import('../../tasks/InProcessTeammateTask/InProcessTeammateTask.js')

function createState() {
  return {
    ...getDefaultAppState(),
    mainLoopModel: 'claude-sonnet-4-6' as const,
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: {
      ...getDefaultAppState().mcp,
      tools: [],
      clients: [],
    },
    tasks: {},
    agentNameRegistry: new Map(),
  }
}

function createToolUseContext(
  getState: () => ReturnType<typeof createState>,
  setState: (updater: (prev: ReturnType<typeof createState>) => ReturnType<typeof createState>) => void,
): ToolUseContext {
  return {
    options: {
      tools: ['Read', 'Bash', 'SendMessage', 'TaskCreate'].map(name => ({ name }) as Tool),
      mainLoopModel: 'claude-sonnet-4-6',
      mcpClients: [],
    },
    abortController: new AbortController(),
    readFileState: {} as never,
    getAppState: getState,
    setAppState: setState,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => 0,
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

async function spawnTask(retain?: boolean, name = 'researcher', teamName = 'retention-team') {
  let state = createState()
  const setState = (
    updater: (prev: typeof state) => typeof state,
  ) => {
    state = updater(state)
  }
  const spawnResult = await spawnInProcessTeammate(
    {
      name,
      teamName,
      prompt: 'inspect only',
      planModeRequired: false,
      permissionMode: 'default',
    },
    {
      setAppState: setState,
    },
  )
  assert.equal(spawnResult.success, true)
  if (!spawnResult.taskId || !spawnResult.abortController || !spawnResult.teammateContext) {
    throw new Error('Expected spawned teammate runtime state')
  }

  const seedMessages = [
    createUserMessage({ content: 'first message' }),
    createUserMessage({ content: 'second message' }),
  ]
  state = {
    ...state,
    tasks: {
      ...state.tasks,
      [spawnResult.taskId]: {
        ...state.tasks[spawnResult.taskId],
        ...(retain !== undefined ? { retain } : {}),
        messages: seedMessages,
      },
    },
  }

  return {
    getState: () => state,
    setState,
    seedMessages,
    taskId: spawnResult.taskId,
    abortController: spawnResult.abortController,
    teammateContext: spawnResult.teammateContext,
  }
}

async function runCase(
  mode: 'complete' | 'fail',
  retain?: true,
  agentDefinition?: AgentDefinition,
  agentId = 'researcher@retention-team',
  followUp?: string,
) {
  const [agentName = 'researcher', teamName = 'retention-team'] =
    agentId.split('@')
  const spawned = await spawnTask(retain, agentName, teamName)
  runAgentMode = mode
  lifecycleAbortController = spawned.abortController
  currentSetState = spawned.setState
  queuedFollowUp = followUp
    ? { taskId: spawned.taskId, message: followUp }
    : undefined
  const parentAgentId = asAgentId('aparent0000000000')
  const parentToolUseContext = createToolUseContext(
    spawned.getState,
    spawned.setState,
  )
  parentToolUseContext.agentId = parentAgentId
  const result = await runInProcessTeammate({
    identity: {
      agentId,
      agentName,
      teamName,
      color: 'blue',
      planModeRequired: false,
      parentSessionId: 'session-retention-test',
    },
    taskId: spawned.taskId,
    prompt: 'inspect only',
    description: 'Retention test teammate',
    model: 'gpt-5.6-sol',
    agentDefinition,
    teammateContext: spawned.teammateContext,
    toolUseContext: parentToolUseContext,
    abortController: spawned.abortController,
  })
  lifecycleAbortController = undefined
  currentSetState = undefined
  queuedFollowUp = undefined
  return {
    result,
    task: spawned.getState().tasks[spawned.taskId],
    seedMessages: spawned.seedMessages,
    parentAgentId,
    parentToolUseContext,
    taskId: spawned.taskId,
  }
}

const completedRetained = await runCase('complete', true)
assert.equal(completedRetained.result.success, true)
assert.equal(observedResolvedModel, 'gpt-5.6-sol')
assert.ok(observedSystemPrompt, 'teammate must pass its structured base prompt to runAgent')
assert.deepEqual([...observedSystemPrompt], [
  `CORE_IDENTITY\n${TEAMMATE_SYSTEM_PROMPT_ADDENDUM}`,
])
assert.deepEqual(getSystemPromptSections(observedSystemPrompt), [
  {
    sections: [
      { name: 'identity', text: 'CORE_IDENTITY' },
      { name: 'language', text: null },
      { text: TEAMMATE_SYSTEM_PROMPT_ADDENDUM },
    ],
    separator: '\n',
  },
])
assert.equal(completedRetained.task?.type, 'in_process_teammate')
assert.equal(completedRetained.task?.status, 'completed')
assert.deepEqual(
  completedRetained.task?.messages?.slice(0, 2),
  completedRetained.seedMessages,
)
assert.equal(completedRetained.task?.messages?.length, 4)

const completedUnretained = await runCase('complete')
assert.equal(completedUnretained.task?.type, 'in_process_teammate')
assert.equal(completedUnretained.task?.status, 'completed')
assert.equal(completedUnretained.task?.messages?.length, 1)
assert.equal(completedUnretained.task?.messages?.[0]?.type, 'assistant')

const failedRetained = await runCase('fail', true)
assert.equal(failedRetained.result.success, false)
assert.equal(failedRetained.task?.type, 'in_process_teammate')
assert.equal(failedRetained.task?.status, 'failed')
assert.equal(failedRetained.task?.error, 'runner boom')
assert.deepEqual(failedRetained.task?.messages?.slice(0, 2), failedRetained.seedMessages)
assert.equal(failedRetained.task?.messages?.length, 3)

const failedUnretained = await runCase('fail')
assert.equal(failedUnretained.task?.type, 'in_process_teammate')
assert.equal(failedUnretained.task?.status, 'failed')
assert.equal(failedUnretained.task?.messages?.length, 1)
assert.equal(failedUnretained.task?.messages?.[0]?.type, 'user')

const killedRetainedSpawn = await spawnTask(true)
const killedRetained = killInProcessTeammate(
  killedRetainedSpawn.taskId,
  killedRetainedSpawn.setState,
)
assert.equal(killedRetained, true)
assert.equal(
  killedRetainedSpawn.getState().tasks[killedRetainedSpawn.taskId]?.type,
  'in_process_teammate',
)
assert.equal(
  killedRetainedSpawn.getState().tasks[killedRetainedSpawn.taskId]?.status,
  'killed',
)
assert.deepEqual(
  killedRetainedSpawn.getState().tasks[killedRetainedSpawn.taskId]?.messages,
  killedRetainedSpawn.seedMessages,
)

const killedViewedTask = killedRetainedSpawn.getState().tasks[killedRetainedSpawn.taskId]!
assert.equal(isViewableTeammate(killedViewedTask), true)
assert.equal(killedViewedTask.evictAfter, undefined)
assert.equal(canEvictTerminalTask(killedViewedTask, Date.now() + 60_000), false)

for (const retain of [undefined, false]) {
  const stopped = await spawnTask(retain)
  const before = Date.now()
  assert.equal(killInProcessTeammate(stopped.taskId, stopped.setState), true)
  const task = stopped.getState().tasks[stopped.taskId]!
  assert.equal(task.status, 'killed')
  assert.equal(isViewableTeammate(task), true, 'first stop must not hide the teammate')
  assert.deepEqual(task.messages, stopped.seedMessages)
  assert.equal(task.retain, false)
  assert.ok(task.evictAfter! >= before + 30_000)
  assert.ok(task.evictAfter! <= Date.now() + 30_000)
  assert.equal(canEvictTerminalTask(task, task.evictAfter! - 1), false)
  assert.equal(canEvictTerminalTask(task, task.evictAfter!), true)
  assert.equal(stopped.abortController.signal.aborted, true)
  assert.equal(killInProcessTeammate(stopped.taskId, stopped.setState), false)
  assert.equal(stopped.getState().tasks[stopped.taskId], task)

  enterTeammateView(stopped.taskId, stopped.setState)
  const viewed = stopped.getState().tasks[stopped.taskId]!
  assert.equal(viewed.evictAfter, undefined)
  assert.equal(canEvictTerminalTask(viewed, before + 60_000), false)
  assert.deepEqual(viewed.messages, stopped.seedMessages)
  exitTeammateView(stopped.setState)
  const released = stopped.getState().tasks[stopped.taskId]!
  assert.ok(released.evictAfter! >= before + 30_000)
  assert.equal(isViewableTeammate(released), true)
  assert.deepEqual(released.messages, stopped.seedMessages)

  dismissTerminalAgent(stopped.taskId, stopped.setState)
  const cleared = stopped.getState().tasks[stopped.taskId]!
  assert.equal(cleared.evictAfter, 0)
  assert.equal(isViewableTeammate(cleared), false)
  assert.equal(canEvictTerminalTask(cleared), true)
}

const originalTeams = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
try {
  const wildcard = await runCase('complete', true, GENERAL_PURPOSE_AGENT)
  assert.equal(wildcard.result.success, true)
  assert.deepEqual(observedTools, ['Read', 'Bash', 'SendMessage', 'TaskCreate'])

  const restricted = await runCase('complete', true, {
    ...GENERAL_PURPOSE_AGENT,
    tools: ['Read'],
  })
  assert.equal(restricted.result.success, true)
  assert.deepEqual(observedTools, ['Read', 'SendMessage', 'TaskCreate'])
} finally {
  if (originalTeams === undefined) delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  else process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalTeams
}

console.log('inProcessRetention.test.ts passed')

test('keeps teammate identity across turns and isolates teammates from their parent', async () => {
  observedOverrides = []
  const stableConversation = await runCase(
    'complete',
    true,
    undefined,
    'researcher@stable-team',
    'second turn',
  )
  assert.equal(stableConversation.result.success, true)
  assert.equal(observedOverrides.length, 2)
  assert.deepEqual(
    observedOverrides.map(override => override.agentId),
    [asAgentId('researcher@stable-team'), asAgentId('researcher@stable-team')],
  )
  assert.notEqual(
    observedOverrides[0]?.abortController,
    observedOverrides[1]?.abortController,
  )
  assert.equal(observedOverrides[0]?.abortController?.signal.aborted, true)
  assert.equal(stableConversation.parentToolUseContext.agentId, stableConversation.parentAgentId)
  assert.equal(stableConversation.task?.type, 'in_process_teammate')
  if (stableConversation.task?.type === 'in_process_teammate') {
    assert.equal(stableConversation.task.identity.agentId, 'researcher@stable-team')
    assert.equal(stableConversation.task.id, stableConversation.taskId)
  }

  const firstConversationOverrides = [...observedOverrides]
  const isolatedConversation = await runCase(
    'complete',
    true,
    undefined,
    'reviewer@stable-team',
  )
  assert.equal(isolatedConversation.result.success, true)
  assert.equal(observedOverrides.length, 3)
  assert.equal(observedOverrides[2]?.agentId, asAgentId('reviewer@stable-team'))
  assert.notEqual(
    firstConversationOverrides[0]?.agentId,
    observedOverrides[2]?.agentId,
  )
  assert.equal(isolatedConversation.parentToolUseContext.agentId, isolatedConversation.parentAgentId)
})
