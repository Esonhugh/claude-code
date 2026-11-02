import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { registerAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { runWithAgentContext } from '../../utils/agentContext.js'
import { logForDebugging } from '../../utils/debug.js'
import { buildChildMessage } from '../../utils/forkBoilerplate.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import { getParentSessionId } from '../../utils/teammate.js'
import { createAgentId } from '../../utils/uuid.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { FORK_AGENT } from './forkSubagent.js'
import { runAgent } from './runAgent.js'
import { getNextSubagentDepth, MAX_SUBAGENT_DEPTH } from './subagentDepth.js'

/** 2.1.311: the fork's name comes from the directive's first three words. */
export function forkNameFromDirective(directive: string): string {
  return (
    directive
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join('-')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'fork'
  )
}

/**
 * Start a background fork of the main conversation that carries out one
 * directive (2.1.311 `spawnForkFromDirective`, used by /btw's "f to fork").
 * Returns null when a fork cannot start here (coordinator mode, depth cap).
 */
export async function spawnForkFromDirective(
  directive: string,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  { extraMessages = [] }: { extraMessages?: Message[] } = {},
): Promise<{ agentId: string; name: string } | null> {
  if (isCoordinatorMode()) return null
  const spawnDepth = getNextSubagentDepth(context.options)
  if (spawnDepth > MAX_SUBAGENT_DEPTH) return null

  const appState = context.getAppState()
  const systemPrompt =
    context.renderedSystemPrompt ??
    buildEffectiveSystemPrompt({
      mainThreadAgentDefinition: appState.agent
        ? appState.agentDefinitions.activeAgents.find(
            a => a.agentType === appState.agent,
          )
        : undefined,
      toolUseContext: context,
      customSystemPrompt: context.options.customSystemPrompt,
      defaultSystemPrompt: await getSystemPrompt(
        context.options.tools,
        context.options.mainLoopModel,
      ),
      appendSystemPrompt: context.options.appendSystemPrompt,
    })

  const setRootState = context.setAppStateForTasks ?? context.setAppState
  const agentId = createAgentId()
  const collapsed = directive.replace(/\s+/g, ' ').trim()
  const description =
    collapsed.length > 50 ? `${collapsed.slice(0, 49)}…` : collapsed
  const task = registerAsyncAgent({
    agentId,
    description,
    prompt: directive,
    selectedAgent: FORK_AGENT,
    setAppState: setRootState,
    toolUseId: context.toolUseId,
    parentAgentId: context.agentId,
    ownerAgentId: context.agentId,
    spawnDepth,
  })
  const base = forkNameFromDirective(directive)
  let name = base
  setRootState(prev => {
    const registry = new Map(prev.agentNameRegistry)
    let suffix = 2
    while (registry.has(name)) name = `${base}-${suffix++}`
    registry.set(name, agentId)
    return { ...prev, agentNameRegistry: registry }
  })
  const resolvedAgentModel = getAgentModel(
    FORK_AGENT.model,
    context.options.mainLoopModel,
    undefined,
    appState.toolPermissionContext.mode,
  )
  const querySource = getQuerySourceForAgent(FORK_AGENT.agentType, true)

  void runWithAgentContext(
    {
      agentId,
      parentSessionId: getParentSessionId(),
      agentType: 'subagent',
      subagentName: FORK_AGENT.agentType,
      isBuiltIn: true,
    },
    () =>
      runAsyncAgentLifecycle({
        taskId: agentId,
        abortController: task.abortController!,
        description,
        toolUseContext: context,
        rootSetAppState: setRootState,
        agentIdForCleanup: agentId,
        enableSummarization: true,
        metadata: {
          prompt: directive,
          resolvedAgentModel,
          isBuiltInAgent: true,
          startTime: Date.now(),
          agentType: FORK_AGENT.agentType,
          isAsync: true,
        },
        makeStream: onCacheSafeParams =>
          runAgent({
            agentDefinition: FORK_AGENT,
            promptMessages: [
              ...extraMessages,
              createUserMessage({ content: buildChildMessage(directive) }),
            ],
            toolUseContext: context,
            canUseTool,
            isAsync: true,
            querySource,
            model: 'inherit',
            availableTools: context.options.tools,
            forkContextMessages: context.messages,
            useExactTools: true,
            name,
            description,
            toolUseId: context.toolUseId,
            parentAgentId: context.agentId,
            spawnDepth,
            override: {
              systemPrompt,
              agentId,
              abortController: task.abortController!,
            },
            onCacheSafeParams,
          }),
        getWorktreeResult: async () => ({}),
      }),
  ).catch(error =>
    logForDebugging(
      `Fork from directive failed (agent ${agentId}): ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    ),
  )
  return { agentId, name }
}
