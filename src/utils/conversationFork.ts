import { getSystemPrompt } from '../constants/prompts.js'
import { isCoordinatorMode } from '../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../Tool.js'
import { registerAsyncAgent } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { runAsyncAgentLifecycle } from '../tools/AgentTool/agentToolUtils.js'
import { buildChildMessage, FORK_AGENT } from '../tools/AgentTool/forkSubagent.js'
import { runAgent } from '../tools/AgentTool/runAgent.js'
import { getNextSubagentDepth } from '../tools/AgentTool/subagentDepth.js'
import type { AgentId } from '../types/ids.js'
import { runWithAgentContext } from './agentContext.js'
import { logForDebugging } from './debug.js'
import { createUserMessage } from './messages.js'
import { getRuntimeMainLoopModel } from './model/model.js'
import { takeSubagentConcurrencySlot } from './subagentConcurrency.js'
import { buildEffectiveSystemPrompt } from './systemPrompt.js'
import { getParentSessionId } from './teammate.js'
import { doesMostRecentAssistantMessageExceed200k } from './tokens.js'
import { createAgentId } from './uuid.js'

/** Explicit user forks run independently of the model's automatic fork gate. */
export async function launchConversationFork(
  directive: string,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
): Promise<{ agentId: AgentId; name: string } | null> {
  if (isCoordinatorMode()) return null
  const state = context.getAppState()
  let systemPrompt = context.renderedSystemPrompt
  if (!systemPrompt) {
    const defaultSystemPrompt = await getSystemPrompt(
      context.options.tools,
      context.options.mainLoopModel,
      Array.from((state.toolPermissionContext.additionalWorkingDirectories as unknown as ReadonlyMap<string, unknown>).keys()),
      context.options.mcpClients,
    )
    systemPrompt = buildEffectiveSystemPrompt({
      mainThreadAgentDefinition: state.agent
        ? state.agentDefinitions.activeAgents.find(agent => agent.agentType === state.agent)
        : undefined,
      toolUseContext: context,
      customSystemPrompt: context.options.customSystemPrompt,
      defaultSystemPrompt,
      appendSystemPrompt: context.options.appendSystemPrompt,
    })
  }
  if (!systemPrompt) return null

  const getRootState = context.getAppStateForTasks ?? context.getAppState
  const setRootState = context.setAppStateForTasks ?? context.setAppState
  const baseName = directive.trim().split(/\s+/).slice(0, 3).join('-').toLowerCase()
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'fork'
  let name = baseName
  let suffix = 2
  while (getRootState().agentNameRegistry.has(name)) name = `${baseName}-${suffix++}`
  const agentId = createAgentId(name)
  const normalizedDescription = directive.replace(/\s+/g, ' ').trim()
  const description = normalizedDescription.length > 50
    ? normalizedDescription.slice(0, 49) + '\u2026' : normalizedDescription
  const spawnDepth = getNextSubagentDepth(context.options)
  const resolvedModel = getRuntimeMainLoopModel({
    permissionMode: state.toolPermissionContext.mode,
    mainLoopModel: context.options.mainLoopModel,
    exceeds200kTokens: state.toolPermissionContext.mode === 'plan' &&
      doesMostRecentAssistantMessageExceed200k(context.messages),
  })
  const task = registerAsyncAgent({
    agentId, description, prompt: directive, selectedAgent: FORK_AGENT,
    setAppState: setRootState, toolUseId: context.toolUseId,
    parentAgentId: context.agentId, ownerAgentId: context.agentId, spawnDepth,
  })
  setRootState(prev => ({ ...prev, agentNameRegistry: new Map(prev.agentNameRegistry).set(name, agentId) }))
  // Explicit /subtask counts towards subsequent model spawns, without rejecting
  // the user's command at the automatic-spawn concurrency limit.
  const releaseSlot = takeSubagentConcurrencySlot(context)
  logForDebugging(`[ConversationFork] started agent=${agentId} name=${name} depth=${spawnDepth} owner=${context.agentId ?? 'root'} model=${resolvedModel}`)
  void runWithAgentContext({
    agentId, parentSessionId: getParentSessionId(), agentType: 'subagent',
    subagentName: FORK_AGENT.agentType, isBuiltIn: true,
    invocationKind: 'spawn', invocationEmitted: false,
  }, () => runAsyncAgentLifecycle({
    taskId: agentId, abortController: task.abortController!,
    description, toolUseContext: context, rootSetAppState: setRootState,
    agentIdForCleanup: agentId, enableSummarization: true,
    metadata: { prompt: directive, resolvedAgentModel: resolvedModel, isBuiltInAgent: true,
      startTime: Date.now(), agentType: FORK_AGENT.agentType, isAsync: true },
    makeStream: onCacheSafeParams => runAgent({
      agentDefinition: FORK_AGENT,
      promptMessages: [createUserMessage({ content: [{ type: 'text', text: buildChildMessage(directive) }] })],
      toolUseContext: context, canUseTool, isAsync: true,
      querySource: 'agent:builtin:fork', model: 'inherit', resolvedModel,
      availableTools: context.options.tools, forkContextMessages: context.messages, useExactTools: true,
      spawnedBySkill: context.options.spawnedBySkill,
      spawnedByForkedSkill: context.options.spawnedByForkedSkill,
      name, description, toolUseId: context.toolUseId, parentAgentId: context.agentId, spawnDepth,
      override: { systemPrompt, agentId, abortController: task.abortController! },
      onCacheSafeParams,
    }),
    getWorktreeResult: async () => ({}), onRunSettled: releaseSlot,
    resume: async prompt => {
      const { resumeAgentBackground } = await import('../tools/AgentTool/resumeAgent.js')
      return resumeAgentBackground({ agentId, prompt, promptIsMeta: true, toolUseContext: context, canUseTool })
    },
  })).catch(error => logForDebugging(
    `[ConversationFork] failed agent=${agentId}: ${error instanceof Error ? error.message : String(error)}`,
    { level: 'error' },
  ))
  return { agentId, name }
}
