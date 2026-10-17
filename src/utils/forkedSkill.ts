import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../Tool.js'
import {
  isLocalAgentTask,
  registerAsyncAgent,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import { runAsyncAgentLifecycle } from '../tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { runAgent } from '../tools/AgentTool/runAgent.js'
import {
  getNextSubagentDepth,
  MAX_SUBAGENT_DEPTH,
} from '../tools/AgentTool/subagentDepth.js'
import type { PromptCommand, CommandBase } from '../types/command.js'
import type { AgentId } from '../types/ids.js'
import { runWithAgentContext } from './agentContext.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { AbortError } from './errors.js'
import type { PreparedForkedContext } from './forkedAgent.js'
import { persistForkedSkillScope } from './forkedSkillScope.js'
import { getAgentModel } from './model/agent.js'
import { getParentSessionId } from './teammate.js'

export function shouldBackgroundForkedSkill(
  command: PromptCommand,
  nonInteractive = false,
): boolean {
  return (
    !nonInteractive &&
    !getIsNonInteractiveSession() &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    (command.background ?? true)
  )
}
export function getSkillAttributionName(
  command: CommandBase & PromptCommand,
): string {
  return command.unqualifiedName ?? command.name
}

/** Return null to use the existing synchronous path when a safe launch is unavailable. */
export async function launchBackgroundForkedSkill({
  command,
  prepared,
  agentDefinition,
  agentId,
  context,
  canUseTool,
}: {
  command: CommandBase & PromptCommand
  prepared: PreparedForkedContext
  agentDefinition: AgentDefinition
  agentId: AgentId
  context: ToolUseContext
  canUseTool: CanUseToolFn
}): Promise<{ agentId: AgentId; name: string } | null> {
  const getRootState = context.getAppStateForTasks ?? context.getAppState
  const setRootState = context.setAppStateForTasks ?? context.setAppState
  const duplicate = () =>
    Object.values(getRootState().tasks).some(
      (task) =>
        isLocalAgentTask(task) &&
        task.forkedSkillName === command.name &&
        (!['completed', 'failed', 'killed'].includes(task.status) ||
          task.resuming ||
          (task.keepaliveReasons?.size ?? 0) > 0),
    )
  const checkAbort = () => {
    if (
      context.abortController.signal.aborted &&
      context.abortController.signal.reason !== 'interrupt'
    )
      throw new AbortError()
  }
  checkAbort()
  const spawnDepth = getNextSubagentDepth(context.options)
  if (spawnDepth > MAX_SUBAGENT_DEPTH || duplicate()) return null
  try {
    await persistForkedSkillScope(agentId, {
      skillName: command.name,
      attributionName: getSkillAttributionName(command),
      ...(agentDefinition.effort !== undefined && {
        effort: agentDefinition.effort,
      }),
      ...(prepared.frozenCommandDenies?.length && {
        frozenCommandDenies: prepared.frozenCommandDenies,
      }),
    })
  } catch (error) {
    logForDebugging(
      `Forked skill /${command.name} scope could not be saved; using synchronous execution: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    return null
  }
  // Persistence yields: re-check duplicate launches and cancellation before registration.
  checkAbort()
  if (duplicate()) return null
  const description = `/${command.name}`.slice(0, 50)
  const task = registerAsyncAgent({
    agentId,
    description,
    prompt: prepared.skillContent,
    selectedAgent: agentDefinition,
    setAppState: setRootState,
    toolUseId: context.toolUseId,
    parentAgentId: context.agentId,
    ownerAgentId: context.agentId,
    spawnDepth,
    forkedSkillName: command.name,
  })
  let name = command.name
  setRootState((prev) => {
    const registry = new Map(prev.agentNameRegistry)
    let suffix = 2
    while (registry.has(name)) name = `${command.name}-${suffix++}`
    registry.set(name, agentId)
    return { ...prev, agentNameRegistry: registry }
  })
  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    context.options.mainLoopModel,
    command.model,
    context.getAppState().toolPermissionContext.mode,
  )
  const scopedContext = {
    ...context,
    getAppState: prepared.modifiedGetAppState,
  }
  logForDebugging(
    `Background forked skill /${command.name} started as @${name} (agent ${agentId}, depth ${spawnDepth}, owner ${context.agentId ?? 'root'})`,
  )
  void runWithAgentContext(
    {
      agentId,
      parentSessionId: getParentSessionId(),
      agentType: 'subagent',
      subagentName: agentDefinition.agentType,
      isBuiltIn: isBuiltInAgent(agentDefinition),
    },
    () =>
      runAsyncAgentLifecycle({
        taskId: agentId,
        abortController: task.abortController!,
        description,
        toolUseContext: context,
        rootSetAppState: setRootState,
        agentIdForCleanup: agentId,
        enableSummarization: false,
        metadata: {
          prompt: prepared.skillContent,
          resolvedAgentModel,
          isBuiltInAgent: isBuiltInAgent(agentDefinition),
          startTime: Date.now(),
          agentType: agentDefinition.agentType,
          isAsync: true,
        },
        makeStream: (onCacheSafeParams) =>
          runAgent({
            agentDefinition,
            promptMessages: prepared.promptMessages,
            toolUseContext: scopedContext,
            canUseTool,
            isAsync: true,
            querySource: 'agent:custom',
            model: command.model,
            availableTools: context.options.tools,
            spawnedBySkill: getSkillAttributionName(command),
            spawnedByForkedSkill: true,
            name,
            description,
            toolUseId: context.toolUseId,
            parentAgentId: context.agentId,
            spawnDepth,
            override: {
              agentId,
              abortController: task.abortController!,
              readFileState: prepared.readFileState,
            },
            onCacheSafeParams,
          }),
        getWorktreeResult: async () => ({}),
        resume: async (prompt) => {
          const { resumeAgentBackground } =
            await import('../tools/AgentTool/resumeAgent.js')
          return resumeAgentBackground({
            agentId,
            prompt,
            promptIsMeta: true,
            toolUseContext: context,
            canUseTool,
          })
        },
      }),
  ).catch((error) =>
    logForDebugging(
      `Background forked skill /${command.name} failed (agent ${agentId}): ${error instanceof Error ? error.message : String(error)}`,
      { level: 'error' },
    ),
  )
  return { agentId, name }
}
