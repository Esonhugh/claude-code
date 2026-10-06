import { promises as fsp } from 'fs'
import { getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { getCommands } from '../../commands.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { markAgentsNotified } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { AgentStoppedByUserError } from '../../utils/agentCancellation.js'
import { hashSubagentHandbackSections, type SubagentHandback } from '../../utils/subagentHandback.js'
import { readForkedSkillScope, readForkedSkillWitness } from '../../utils/forkedSkillScope.js'
import { createGetAppStateWithAllowedTools } from '../../utils/forkedAgent.js'
import { getSkillAttributionName } from '../../utils/forkedSkill.js'
import { parseToolListFromCLI } from '../../utils/permissions/permissionSetup.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { registerAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { assembleToolPool } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import { runWithAgentContext } from '../../utils/agentContext.js'
import { takeSubagentConcurrencySlot } from '../../utils/subagentConcurrency.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { getRuntimeMainLoopModel } from '../../utils/model/model.js'
import { doesMostRecentAssistantMessageExceed200k } from '../../utils/tokens.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  isPlanModeAvailable,
  PLAN_MODE_DISABLED_MESSAGE,
} from '../../utils/planModeV2.js'
import {
  getAgentTranscript,
  readAgentMetadata,
} from '../../utils/sessionStorage.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getParentSessionId } from '../../utils/teammate.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import {
  resolveAgentTools,
  runAsyncAgentLifecycle,
} from './agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { FORK_AGENT, isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'
import { shouldBubbleAgentPermissionPrompts } from './permissionMode.js'

export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
  inlineHandback?: SubagentHandback
}
export async function resumeAgentBackground({
  agentId,
  prompt,
  toolUseContext,
  canUseTool,
  invokingRequestId,
  promptIsMeta,
  getWorktreeResult,
  delivery = 'notification',
}: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
  promptIsMeta?: boolean
  getWorktreeResult?: () => Promise<{worktreePath?: string; worktreeBranch?: string}>
  delivery?: 'notification' | 'reply'
}): Promise<ResumeAgentResult> {
  const refuseUserStop = () => {
    const task = toolUseContext.getAppState().tasks[agentId]
    if (isLocalAgentTask(task) && task.stoppedByUser) {
      logForDebugging(`[AgentCancellation] resume_refused agent_id=${agentId} source=live`, { level: 'warn' })
      throw new AgentStoppedByUserError(agentId)
    }
  }
  refuseUserStop()
  const startTime = Date.now()
  const inline = delivery === 'reply' && isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)
  const appState = toolUseContext.getAppState()
  // In-process teammates get a no-op setAppState; setAppStateForTasks
  // reaches the root store so task registration/progress/kill stay visible.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const [transcript, meta] = await Promise.all([
    getAgentTranscript(asAgentId(agentId)),
    readAgentMetadata(asAgentId(agentId)),
  ])
  if (meta?.stoppedByUser) {
    logForDebugging(`[AgentCancellation] resume_refused agent_id=${agentId} source=metadata`, { level: 'warn' })
    throw new AgentStoppedByUserError(agentId)
  }
  const savedScope = await readForkedSkillScope(asAgentId(agentId))
  const liveTask = appState.tasks[agentId]
  const isLiveTask = isLocalAgentTask(liveTask)
  const refuse = (message: string): never => {
    logForDebugging(`Forked skill resume refused (agent ${agentId}): ${message}`, { level: 'warn' })
    throw new Error(message)
  }
  if (savedScope.status === 'malformed') refuse(`Agent ${agentId} has a malformed forked-skill scoping record; refusing to resume it without the skill's permission scoping.`)
  if (savedScope.status === 'absent-but-marked' || (savedScope.status === 'absent' && isLiveTask && liveTask.forkedSkillName !== undefined)) {
    refuse(`Agent ${agentId} ran as a forked skill but its scoping record is missing; refusing to resume it without the skill's permission scoping.`)
  }
  const scope = savedScope.status === 'valid' ? savedScope.scoping : undefined
  if (scope) {
    if (isLiveTask ? liveTask.forkedSkillName !== scope.skillName : await readForkedSkillWitness(asAgentId(agentId)) !== scope.skillName) {
      refuse(`Agent ${agentId} has no matching forked-skill provenance witness; refusing to resume it.`)
    }
  }
  let workerContext = toolUseContext
  let skillAttribution: string | undefined
  if (scope) {
    const commands = [...await getCommands(getProjectRoot()), ...toolUseContext.getAppState().mcp.commands]
    const command = commands.find(c => c.name === scope.skillName && c.type === 'prompt')
    if (command?.type !== 'prompt' || command.context !== 'fork') {
      refuse(`Agent ${agentId} ran as forked skill ${scope.skillName}, which no longer resolves to a fork-capable skill; refusing to resume it without its permission scoping.`)
    }
    // Resolve today's skill grants; retain launch-time denies and all current denies.
    if (command?.type === 'prompt') {
      workerContext = { ...toolUseContext, getAppState: createGetAppStateWithAllowedTools(
        toolUseContext.getAppState, parseToolListFromCLI(command.allowedTools ?? []),
        parseToolListFromCLI(command.disallowedTools ?? []),
        { replaceCommandRules: true, frozenCommandDenies: scope.frozenCommandDenies ?? appState.toolPermissionContext.alwaysDenyRules.command ?? [] },
      ) }
      skillAttribution = getSkillAttributionName(command)
    }
  }
  if (!transcript) {
    throw new Error(`No transcript found for agent ID: ${agentId}`)
  }
  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )
  const resumedReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    resumedMessages,
    transcript.contentReplacements,
  )
  // Best-effort: if the original worktree was removed externally, fall back
  // to parent cwd rather than crashing on chdir later.
  const resumedWorktreePath = meta?.worktreePath
    ? await fsp.stat(meta.worktreePath).then(
        s => (s.isDirectory() ? meta.worktreePath : undefined),
        () => {
          logForDebugging(
            `Resumed worktree ${meta.worktreePath} no longer exists; falling back to parent cwd`,
          )
          return undefined
        },
      )
    : undefined
  if (resumedWorktreePath) {
    // Bump mtime so stale-worktree cleanup doesn't delete a just-resumed worktree (#22355)
    const now = new Date()
    await fsp.utimes(resumedWorktreePath, now, now)
  }

  // Skip filterDeniedAgents re-gating — original spawn already passed permission checks
  let selectedAgent: AgentDefinition
  let isResumedFork = false
  if (meta?.agentType === FORK_AGENT.agentType) {
    selectedAgent = FORK_AGENT
    isResumedFork = true
  } else if (meta?.agentType) {
    const found = toolUseContext.options.agentDefinitions.activeAgents.find(
      a => a.agentType === meta.agentType,
    )
    selectedAgent = found ?? GENERAL_PURPOSE_AGENT
  } else {
    selectedAgent = GENERAL_PURPOSE_AGENT
  }

  if (scope?.effort !== undefined) selectedAgent = { ...selectedAgent, effort: scope.effort }
  const uiDescription = meta?.description ?? '(resumed)'

  let forkParentSystemPrompt: SystemPrompt | undefined
  if (isResumedFork) {
    if (toolUseContext.renderedSystemPrompt) {
      forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
    } else {
      const mainThreadAgentDefinition = appState.agent
        ? appState.agentDefinitions.activeAgents.find(
            a => a.agentType === appState.agent,
          )
        : undefined
      const additionalWorkingDirectories = Array.from(
        // @ts-ignore - recovered code
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      )
      const defaultSystemPrompt = await getSystemPrompt(
        toolUseContext.options.tools,
        toolUseContext.options.mainLoopModel,
        // @ts-ignore - recovered code
        additionalWorkingDirectories,
        toolUseContext.options.mcpClients,
      )
      forkParentSystemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt: toolUseContext.options.customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
      })
    }
    if (!forkParentSystemPrompt) {
      throw new Error(
        'Cannot resume fork agent: unable to reconstruct parent system prompt',
      )
    }
  }

  const permissionMode = appState.toolPermissionContext.mode === 'bypassPermissions'
    ? 'bypassPermissions'
    : (meta?.permissionMode ??
      selectedAgent.permissionMode ??
      appState.toolPermissionContext.mode)
  // Preserve recorded/inherited Plan restrictions, but gate a new definition entry.
  if (
    permissionMode === 'plan' &&
    meta?.permissionMode !== 'plan' &&
    appState.toolPermissionContext.mode !== 'plan' &&
    !isPlanModeAvailable()
  ) {
    throw new Error(PLAN_MODE_DISABLED_MESSAGE)
  }
  const workerPermissionContext =
    permissionMode === appState.toolPermissionContext.mode
      ? appState.toolPermissionContext
      : { ...appState.toolPermissionContext, mode: permissionMode }

  // Resolve model for analytics metadata (runAgent resolves its own internally)
  const resolvedAgentModel = isResumedFork ? getRuntimeMainLoopModel({
    permissionMode: appState.toolPermissionContext.mode,
    mainLoopModel: toolUseContext.options.mainLoopModel,
    exceeds200kTokens: appState.toolPermissionContext.mode === 'plan' &&
      doesMostRecentAssistantMessageExceed200k(toolUseContext.messages),
  }) : getAgentModel(
    selectedAgent.model,
    toolUseContext.options.mainLoopModel,
    meta?.model,
    permissionMode,
  )

  const workerTools = isResumedFork
    ? toolUseContext.options.tools
    : assembleToolPool(workerPermissionContext, appState.mcp.tools)
  const resolvedAgentTools = isResumedFork
    ? undefined
    : resolveAgentTools(
        { ...selectedAgent, permissionMode },
        workerTools,
        true,
      )
  const allowedTools = resolvedAgentTools?.hasWildcard
    ? undefined
    : resolvedAgentTools?.validTools

  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({ content: prompt, isMeta: promptIsMeta || undefined }),
    ],
    toolUseContext: workerContext,
    canUseTool,
    isAsync: true,
    spawnedBySkill: skillAttribution,
    spawnedByForkedSkill: scope ? true : undefined,
    canShowPermissionPrompts: shouldBubbleAgentPermissionPrompts(
      selectedAgent.permissionMode,
      permissionMode,
    )
      ? true
      : undefined,
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    model: meta?.model,
    ...(isResumedFork && { resolvedModel: resolvedAgentModel }),
    // Fork resume: pass parent's system prompt (cache-identical prefix).
    // Non-fork: undefined → runAgent recomputes under wrapWithCwd so
    // getCwd() sees resumedWorktreePath.
    override: isResumedFork
      ? { systemPrompt: forkParentSystemPrompt }
      : undefined,
    availableTools: workerTools,
    permissionMode,
    allowedTools,
    // Transcript already contains the parent context slice from the
    // original fork. Re-supplying it would cause duplicate tool_use IDs.
    forkContextMessages: undefined,
    ...(isResumedFork && { useExactTools: true }),
    // Re-persist so metadata survives runAgent's writeAgentMetadata overwrite
    worktreePath: resumedWorktreePath,
    description: meta?.description,
    name: meta?.name,
    contentReplacementState: resumedReplacementState,
    parentAgentId: meta?.parentAgentId,
    spawnDepth: meta?.spawnDepth ?? 1,
  }

  // Cold skill resumes recover their routing name without replacing a live owner.
  if (scope && meta?.name) {
    const name = meta.name
    rootSetAppState(prev => {
      if (prev.agentNameRegistry.has(name)) return prev
      const registry = new Map(prev.agentNameRegistry)
      registry.set(name, asAgentId(agentId))
      return { ...prev, agentNameRegistry: registry }
    })
  }
  // Permission, transcript and scope reads can yield while the user stops it.
  // Recheck the current store immediately before replacing the stopped task.
  refuseUserStop()
  const agentBackgroundTask = registerAsyncAgent({
    agentId,
    description: uiDescription,
    prompt,
    selectedAgent,
    setAppState: rootSetAppState,
    toolUseId: toolUseContext.toolUseId,
    parentAgentId: meta?.parentAgentId,
    ownerAgentId: toolUseContext.agentId,
    forkedSkillName: scope?.skillName,
    spawnDepth: meta?.spawnDepth ?? 1,
  })

  const releaseSlot = takeSubagentConcurrencySlot(toolUseContext)

  const metadata = {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent: isBuiltInAgent(selectedAgent),
    startTime,
    agentType: selectedAgent.agentType,
    isAsync: true,
  }

  const asyncAgentContext = {
    agentId,
    parentSessionId: getParentSessionId(),
    agentType: 'subagent' as const,
    subagentName: selectedAgent.agentType,
    isBuiltIn: isBuiltInAgent(selectedAgent),
    invokingRequestId,
    invocationKind: 'resume' as const,
    invocationEmitted: false,
  }

  const wrapWithCwd = <T>(fn: () => T): T =>
    resumedWorktreePath ? runWithCwdOverride(resumedWorktreePath, fn) : fn()

  // A resumed execution reuses its logical ID but starts a new prompt-context
  // lifetime. Running agents keep their pinned generation until this boundary.
  toolUseContext.mods?.invalidatePromptContext(agentId)

  const abortInline = () => agentBackgroundTask.abortController!.abort(toolUseContext.abortController.signal.reason)
  if (inline) {
    if (toolUseContext.abortController.signal.aborted) abortInline()
    else toolUseContext.abortController.signal.addEventListener('abort', abortInline, {once:true})
  }
  logForDebugging(`[AgentResume] started agent=${agentId} delivery=${inline ? 'inline' : 'notification'} model=${resolvedAgentModel}`)
  const execution = runWithAgentContext(asyncAgentContext, () =>
    wrapWithCwd(() =>
      runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        makeStream: onCacheSafeParams =>
          runAgent({
            ...runAgentParams,
            override: {
              ...runAgentParams.override,
              agentId: asAgentId(agentBackgroundTask.agentId),
              abortController: agentBackgroundTask.abortController!,
            },
            onCacheSafeParams,
          }),
        metadata,
        description: uiDescription,
        toolUseContext,
        rootSetAppState,
        shouldNotifyOwner: inline ? () => false : undefined,
        onRunSettled: releaseSlot,
        resume: nextPrompt => resumeAgentBackground({
          agentId,
          prompt: nextPrompt,
          promptIsMeta: true,
          toolUseContext,
          canUseTool,
          invokingRequestId,
          getWorktreeResult,
        }),
        agentIdForCleanup: agentId,
        enableSummarization:
          isCoordinatorMode() ||
          isForkSubagentEnabled() ||
          getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: getWorktreeResult ?? (async () =>
          resumedWorktreePath ? { worktreePath: resumedWorktreePath } : {}),
      }),
    ),
  )

  if (inline) {
    try {
      await execution
      const task = toolUseContext.getAppState().tasks[agentId]
      if (!isLocalAgentTask(task) || task.status !== 'completed' || !task.result) {
        throw new Error(isLocalAgentTask(task) ? task.error ?? `Agent ${agentId} ${task.status}` : `Agent ${agentId} disappeared while resuming`)
      }
      logForDebugging(`[AgentResume] handed back agent=${agentId} delivery=inline status=${task.status}`)
      return { agentId, description: uiDescription, outputFile: getTaskOutputPath(agentId), inlineHandback: {
        content: task.result.content, harnessNoteCount: 0, harnessTailCount: 0,
        harnessSectionHash: hashSubagentHandbackSections(task.result.content),
      } }
    } finally {
      toolUseContext.abortController.signal.removeEventListener('abort', abortInline)
      markAgentsNotified(agentId, rootSetAppState)
    }
  }

  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),
  }
}
