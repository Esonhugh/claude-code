import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { AssistantMessage, NormalizedUserMessage } from '../../types/message.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
  COMMAND_MESSAGE_TAG,
} from '../../constants/xml.js'
import { getCwd } from '../../utils/cwd.js'
import { createChildAbortController } from '../../utils/abortController.js'
import {
  completeWorkflowAgent,
  completeWorkflowTask,
  failWorkflowAgent,
  failWorkflowTask,
  recordWorkflowAgentController,
  recordWorkflowAgentProgress,
  recordWorkflowAgentStarted,
  recordWorkflowEvent,
  registerWorkflowTask,
  startWorkflowPhase,
  workflowResumeCall,
  WORKFLOW_AGENT_SKIPPED_ABORT_REASON,
  WORKFLOW_AGENT_USER_RETRY_ABORT_REASON,
  type WorkflowAgentResult,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {
  WorkflowArgs,
  WorkflowDryRunPhase,
  WorkflowDryRunPlan,
  WorkflowPermissionMode,
  WorkflowProgressEvent,
} from './workflowSpec.js'
import {
  createWorkflowAgentEvent,
  createWorkflowLogEvent,
  createWorkflowPhaseEvent,
  createWorkflowProgressEvent,
} from './workflowEvents.js'
import {
  appendWorkflowRunEvent,
  completeWorkflowRunSession,
  failWorkflowRunSession,
  loadWorkflowRunSession,
  startWorkflowRunSession,
  updateWorkflowRunSessionProgress,
  updateWorkflowRunSessionStatus,
  type WorkflowRunSession,
} from './workflowRunSessions.js'
import {
  createAgentCallIdentity,
  createWorkflowResumeCursor,
  recordResumeCacheEntry,
  type WorkflowResumeCacheEntry,
} from './workflowResumeCache.js'
import { createWorkflowRunId } from './workflowScriptPersistence.js'
import { workflowPhaseExecutionOrder } from './workflowPhaseScheduler.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { emitTaskProgress } from '../../utils/task/sdkProgress.js'
import {
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const DEFAULT_STALL_MS = 120_000
const TAG_CONTENT_ESCAPE = String.raw`([\s\S]*?)`
const COMMAND_MESSAGE_RE = new RegExp(`<${COMMAND_MESSAGE_TAG}>${TAG_CONTENT_ESCAPE}<\\/${COMMAND_MESSAGE_TAG}>`)

type AgentToolInput = {
  description: string
  prompt: string
  subagent_type?: string
  model?: 'sonnet' | 'opus' | 'haiku'
  mode?: WorkflowPermissionMode
  name?: string
  team_name?: string
}

type AgentToolOutput = {
  status?: string
  content?: Array<{ type: string; text?: string }>
  totalTokens?: number
  totalToolUseCount?: number
  totalDurationMs?: number
}

type WorkflowResumeRuntime = {
  cursor: ReturnType<typeof createWorkflowResumeCursor>
  entries: WorkflowResumeCacheEntry[]
}

type WorkflowAgentRunResult = {
  result: WorkflowAgentResult
  cacheHit: boolean
}

type AgentProgressMetrics = {
  message?: AssistantMessage
  prompt?: string
  activities?: string[]
}

function compactToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const command = (input as { command?: unknown }).command
  if (typeof command === 'string' && command.trim() !== '') return command.trim()
  const prompt = (input as { prompt?: unknown }).prompt
  if (typeof prompt === 'string' && prompt.trim() !== '') return prompt.trim()
  return ''
}

function toolActivitiesFromAssistant(assistant: AssistantMessage): string[] {
  return assistant.message.content.flatMap(block => {
    if (block.type !== 'tool_use') return []
    const input = compactToolInput(block.input)
    return input ? [`${block.name}(${input})`] : [block.name]
  })
}

function commandActivityFromUser(user: NormalizedUserMessage): string | undefined {
  const text = user.message.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
  const command = COMMAND_MESSAGE_RE.exec(text)?.[1]?.trim()
  if (!command) return undefined
  return text.includes('<skill-format>true</skill-format>') ? `Skill(${command})` : command
}

function agentProgressMetrics(progress: unknown): AgentProgressMetrics | undefined {
  if (!progress || typeof progress !== 'object' || !('data' in progress)) return undefined
  const data = (progress as { data?: unknown }).data
  if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== 'agent_progress') return undefined
  const prompt = (data as { prompt?: unknown }).prompt
  const message = (data as { message?: unknown }).message
  if (!message || typeof message !== 'object') {
    return typeof prompt === 'string' && prompt.trim() !== ''
      ? { prompt: prompt.trim() }
      : undefined
  }
  if ((message as { type?: unknown }).type === 'user') {
    const activity = commandActivityFromUser(message as NormalizedUserMessage)
    return typeof prompt === 'string' && prompt.trim() !== '' || activity
      ? {
          prompt: typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : undefined,
          activities: activity ? [activity] : undefined,
        }
      : undefined
  }
  if ((message as { type?: unknown }).type !== 'assistant') {
    return typeof prompt === 'string' && prompt.trim() !== ''
      ? { prompt: prompt.trim() }
      : undefined
  }
  const assistant = message as AssistantMessage
  return {
    message: assistant,
    prompt: typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : undefined,
    activities: toolActivitiesFromAssistant(assistant),
  }
}

function findAgentTool(tools: readonly Tool[]): Tool | undefined {
  return tools.find(
    tool => AGENT_TOOL_NAMES.has(tool.name) || tool.aliases?.some(alias => AGENT_TOOL_NAMES.has(alias)),
  )
}

function mapPermissionMode(mode: WorkflowPermissionMode): WorkflowPermissionMode | undefined {
  return mode === 'default' ? undefined : mode
}

function mapModel(model: string | undefined): 'sonnet' | 'opus' | 'haiku' | undefined {
  if (!model) return undefined
  if (model.includes('haiku')) return 'haiku'
  if (model.includes('opus')) return 'opus'
  if (model.includes('sonnet')) return 'sonnet'
  return undefined
}

function workflowAbortStatus(reason: unknown): 'paused' | 'killed' | undefined {
  if (reason === 'workflow-paused') return 'paused'
  if (reason === 'workflow-killed') return 'killed'
  return undefined
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function workflowTeamName(context: ToolUseContext): string | undefined {
  const state = context.getAppState()
  return state.teamContext?.teamName
}

function workflowCwd(context: ToolUseContext): string {
  if ('getCwd' in context && typeof context.getCwd === 'function') {
    return context.getCwd()
  }
  return getCwd()
}

function workflowAgentName(
  plan: WorkflowDryRunPlan,
  phase: WorkflowDryRunPhase,
  index: number,
): string {
  const label = phase.agentLabels?.[index]
  if (label) {
    const occurrence = phase.agentLabels
      ?.slice(0, index + 1)
      .filter(current => current === label)
      .length ?? 1
    return occurrence === 1 ? label : `${label} [${occurrence}]`
  }
  if (phase.displayName && phase.fanout === 1) return phase.displayName
  if (phase.displayName) return `${phase.displayName}-${index + 1}`
  return `${slug(plan.name) || 'workflow'}-${slug(phase.id) || 'phase'}-${index + 1}`
}

function formatUpstreamOutputs(
  phase: WorkflowDryRunPhase,
  resultsByPhase: Map<string, WorkflowAgentResult[]>,
): string {
  if (phase.dependsOn.length === 0) return ''

  const lines = ['Upstream phase outputs:']
  for (const dependencyId of phase.dependsOn) {
    lines.push(`## ${dependencyId}`)
    for (const result of resultsByPhase.get(dependencyId) ?? []) {
      lines.push(`- ${result.agentId}: ${result.output ?? result.error ?? result.status}`)
    }
  }
  return lines.join('\n')
}

function formatRunArgs(runArgs: WorkflowArgs | undefined): string {
  if (runArgs === undefined || runArgs === null) return ''
  if (typeof runArgs === 'string') return runArgs.trim()
  return JSON.stringify(runArgs, null, 2)
}

async function writeWorkflowResult(taskId: string, resultText: string): Promise<string> {
  const outputFile = getTaskOutputPath(taskId)
  await mkdir(dirname(outputFile), { recursive: true })
  await writeFile(outputFile, resultText)
  return outputFile
}

function escapeXmlText(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function enqueueWorkflowCompletionNotification({
  taskId,
  toolUseId,
  summary,
  outputFile,
  resultText,
}: {
  taskId: string
  toolUseId?: string
  summary: string
  outputFile: string
  resultText: string
}): void {
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${escapeXmlText(toolUseId)}</${TOOL_USE_ID_TAG}>`
    : ''
  const escapedResult = escapeXmlText(resultText)
  const truncatedResult = escapedResult.length > 8000
    ? `${escapedResult.slice(0, 8000)}\n... (truncated ${escapedResult.length - 8000} chars, full result in ${escapeXmlText(outputFile)})`
    : escapedResult
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${escapeXmlText(taskId)}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${escapeXmlText(outputFile)}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>completed</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXmlText(summary)}</${SUMMARY_TAG}>
<result>${truncatedResult}</result>
</${TASK_NOTIFICATION_TAG}>`
  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

function buildAgentPrompt(
  phase: WorkflowDryRunPhase,
  index: number,
  resultsByPhase: Map<string, WorkflowAgentResult[]>,
  runArgs: WorkflowArgs | undefined,
  injectRunArgsIntoRootPrompt: boolean,
): string {
  const parts = [phase.agentPrompts?.[index] ?? phase.prompt]
  const upstream = formatUpstreamOutputs(phase, resultsByPhase)
  if (upstream) parts.push(upstream)
  // Inject runArgs into prompts for phases with no upstream dependencies
  // (root phases that need the user's input to operate)
  const formattedArgs = formatRunArgs(runArgs)
  if (injectRunArgsIntoRootPrompt && formattedArgs && phase.dependsOn.length === 0) {
    parts.push(`User input:\n${formattedArgs}`)
  }
  return parts.join('\n\n')
}

async function emitWorkflowEvent({
  cwd,
  session,
  taskId,
  event,
  setAppState,
}: {
  cwd: string
  session: WorkflowRunSession
  taskId: string
  event: WorkflowProgressEvent
  setAppState: ToolUseContext['setAppState']
}): Promise<WorkflowRunSession> {
  recordWorkflowEvent({ taskId, event, setAppState })
  return appendWorkflowRunEvent({ cwd, session, event })
}

function extractAgentOutput(output: AgentToolOutput): string {
  const text = output.content
    ?.map(block => (block.type === 'text' ? block.text ?? '' : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || output.status || 'completed'
}

function maxRetriesFor(plan: WorkflowDryRunPlan): number {
  return plan.defaults.maxRetries ?? 0
}

function formatAgentDescription(
  plan: WorkflowDryRunPlan,
  phase: WorkflowDryRunPhase,
  index: number,
  attempt: number,
  userRetryAttempt = 0,
): string {
  const base =
    phase.fanout > 1
      ? `${plan.name}: ${phase.id} ${index + 1}/${phase.fanout}`
      : `${plan.name}: ${phase.id}`
  const physicalAttempt = attempt + userRetryAttempt
  if (physicalAttempt === 0) return base
  return userRetryAttempt > 0
    ? `${base} retry ${physicalAttempt}`
    : `${base} retry ${attempt}/${maxRetriesFor(plan)}`
}

function retryAgentId(baseAgentId: string, physicalAttempt: number): string {
  return physicalAttempt > 0 ? `${baseAgentId} (retry ${physicalAttempt})` : baseAgentId
}

async function runPhaseAgentAttempt({
  agentTool,
  phase,
  index,
  attempt,
  plan,
  context,
  canUseTool,
  assistantMessage,
  taskId,
  prompt,
  workflowAbortController,
  userRetryAttempt = 0,
}: {
  agentTool: Tool
  phase: WorkflowDryRunPhase
  index: number
  attempt: number
  plan: WorkflowDryRunPlan
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  taskId: string
  prompt: string
  workflowAbortController: AbortController
  userRetryAttempt?: number
}): Promise<WorkflowAgentResult> {
  const description = formatAgentDescription(plan, phase, index, attempt, userRetryAttempt)
  const teamName =
    plan.defaults.execution === 'team' ? workflowTeamName(context) : undefined
  const input: AgentToolInput = {
    description,
    prompt,
    subagent_type: phase.agentType,
    model: mapModel(phase.model),
    mode: mapPermissionMode(phase.permissionMode),
    ...(teamName
      ? {
          name: workflowAgentName(plan, phase, index),
          team_name: teamName,
        }
      : {}),
  }
  const baseAgentId = workflowAgentName(plan, phase, index)
  const physicalAttempt = attempt + userRetryAttempt
  const fallbackAgentId = retryAgentId(baseAgentId, physicalAttempt)
  const taskSetAppState = context.setAppStateForTasks ?? context.setAppState
  const appState = context.getAppState()
  const taskState = appState.tasks[taskId]
  const existingAttempt = taskState?.type === 'local_workflow'
    ? taskState.agentAttempts?.find(current =>
        current.phaseId === phase.id &&
        current.logicalAgentId === baseAgentId &&
        current.attempt === physicalAttempt,
      )
    : undefined
  recordWorkflowAgentStarted({
    taskId,
    phaseId: phase.id,
    agentId: fallbackAgentId,
    logicalAgentId: baseAgentId,
    attempt: physicalAttempt,
    retryOfAttemptId: physicalAttempt > 0
      ? `${phase.id}:${baseAgentId}:attempt:${physicalAttempt - 1}`
      : undefined,
    recordAttempt: !existingAttempt,
    index,
    setAppState: taskSetAppState,
  })
  const progressStartTime = Date.now()
  let progressTokens = 0
  let progressToolUses = 0
  const progressTracker = createProgressTracker()
  emitTaskProgress({
    taskId,
    toolUseId: context.toolUseId,
    description: `${phase.id}: ${fallbackAgentId}`,
    startTime: progressStartTime,
    totalTokens: 0,
    toolUses: 0,
    lastToolName: fallbackAgentId,
    summary: `Workflow agent started: ${fallbackAgentId}`,
  })
  const agentAbortController = createChildAbortController(workflowAbortController)
  recordWorkflowAgentController({
    taskId,
    agentId: fallbackAgentId,
    abortController: agentAbortController,
    setAppState: context.setAppStateForTasks ?? context.setAppState,
    baseAgentId,
    index,
    userRetryAttempt,
  })
  const agentContext = {
    ...context,
    abortController: agentAbortController,
    options: {
      ...context.options,
      disableNestedAgentTools: true,
    },
  }

  const stallMs = context.options.workflowAgentStallMs ?? DEFAULT_STALL_MS
  let lastProgress = Date.now()
  const stallTimer = setInterval(() => {
    if (Date.now() - lastProgress > stallMs) {
      agentAbortController.abort('stalled')
    }
  }, Math.min(stallMs / 2, 30_000))

  let result: Awaited<ReturnType<Tool['call']>>
  try {
    result = await agentTool.call(input as never, agentContext, canUseTool, assistantMessage, progress => {
      lastProgress = Date.now()
      const metrics = agentProgressMetrics(progress)
      if (!metrics) return
      const previousTokens = progressTokens
      const previousToolUses = progressToolUses
      if (metrics.message) {
        updateProgressFromMessage(progressTracker, metrics.message)
        const update = getProgressUpdate(progressTracker)
        progressTokens = update.tokenCount
        progressToolUses = update.toolUseCount
      }
      emitTaskProgress({
        taskId,
        toolUseId: context.toolUseId,
        description: `${phase.id}: ${fallbackAgentId}`,
        startTime: progressStartTime,
        totalTokens: progressTokens,
        toolUses: progressToolUses,
        lastToolName: fallbackAgentId,
        summary: `Workflow agent running: ${fallbackAgentId}`,
      })
      const tokenDelta = progressTokens - previousTokens
      const toolUseDelta = progressToolUses - previousToolUses
      const activities = metrics.message
        ? toolUseDelta > 0 ? (metrics.activities?.slice(-toolUseDelta) ?? []) : []
        : (metrics.activities ?? [])
      const updates = activities.length > 0 ? activities : [undefined]
      for (const [activityIndex, activity] of updates.entries()) {
        recordWorkflowAgentProgress({
          taskId,
          agentId: fallbackAgentId,
          tokenCount: activityIndex === 0 ? tokenDelta : 0,
          toolUseCount: activity && metrics.message ? 1 : activityIndex === 0 ? toolUseDelta : 0,
          prompt: metrics.prompt,
          activity,
          setAppState: context.setAppStateForTasks ?? context.setAppState,
        })
      }
    })
  } catch (error) {
    if (agentAbortController.signal.reason === 'stalled') {
      throw new Error('stalled')
    }
    if (agentAbortController.signal.reason === WORKFLOW_AGENT_USER_RETRY_ABORT_REASON) {
      throw new Error(WORKFLOW_AGENT_USER_RETRY_ABORT_REASON)
    }
    if (agentAbortController.signal.reason === WORKFLOW_AGENT_SKIPPED_ABORT_REASON) {
      throw new Error(WORKFLOW_AGENT_SKIPPED_ABORT_REASON)
    }
    throw error
  } finally {
    clearInterval(stallTimer)
  }
  const output = result.data as AgentToolOutput
  const agentId = fallbackAgentId
  emitTaskProgress({
    taskId,
    toolUseId: context.toolUseId,
    description: `${phase.id}: ${fallbackAgentId}`,
    startTime: progressStartTime,
    totalTokens: output.totalTokens ?? progressTokens,
    toolUses: output.totalToolUseCount ?? progressToolUses,
    lastToolName: fallbackAgentId,
    summary: `Workflow agent completed: ${fallbackAgentId}`,
  })
  const workflowResult: WorkflowAgentResult = {
    phaseId: phase.id,
    agentId,
    index,
    status: 'completed',
    output: extractAgentOutput(output),
    tokenCount: output.totalTokens ?? progressTokens,
    toolUseCount: output.totalToolUseCount ?? progressToolUses,
    durationMs: output.totalDurationMs ?? 0,
  }
  completeWorkflowAgent({
    taskId,
    result: workflowResult,
    setAppState: context.setAppStateForTasks ?? context.setAppState,
  })
  return workflowResult
}

async function runPhaseAgent({
  agentTool,
  phase,
  index,
  agentIndex,
  plan,
  context,
  canUseTool,
  assistantMessage,
  taskId,
  workflowAbortController,
  resultsByPhase,
  resumeRuntime,
  runArgs,
  injectRunArgsIntoRootPrompt,
}: {
  agentTool: Tool
  phase: WorkflowDryRunPhase
  index: number
  agentIndex: number
  plan: WorkflowDryRunPlan
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  taskId: string
  workflowAbortController: AbortController
  resultsByPhase: Map<string, WorkflowAgentResult[]>
  resumeRuntime: WorkflowResumeRuntime
  runArgs?: WorkflowArgs
  injectRunArgsIntoRootPrompt: boolean
}): Promise<WorkflowAgentRunResult> {
  const prompt = buildAgentPrompt(phase, index, resultsByPhase, runArgs, injectRunArgsIntoRootPrompt)
  const identity = createAgentCallIdentity({
    index: agentIndex,
    phase: phase.id,
    prompt,
    opts: {
      label: workflowAgentName(plan, phase, index),
      model: phase.model,
      agentType: phase.agentType,
      permissionMode: phase.permissionMode,
    },
  })
  const cacheLookup = resumeRuntime.cursor.lookup(agentIndex, identity)
  if (cacheLookup.cacheHit) {
    const cachedResult = cacheLookup.result as WorkflowAgentResult
    recordWorkflowAgentStarted({
      taskId,
      phaseId: phase.id,
      agentId: cachedResult.agentId,
      recordAttempt: false,
      index,
      setAppState: context.setAppStateForTasks ?? context.setAppState,
    })
    completeWorkflowAgent({
      taskId,
      result: cachedResult,
      setAppState: context.setAppStateForTasks ?? context.setAppState,
    })
    resumeRuntime.entries.push(recordResumeCacheEntry({
      index: agentIndex,
      identity,
      phase: phase.id,
      label: cachedResult.agentId,
      result: cachedResult,
    }))
    return { result: cachedResult, cacheHit: true }
  }

  let lastError: unknown
  let lastFailedResult: WorkflowAgentResult | undefined
  let userRetryAttempt = 0
  for (let attempt = 0; attempt <= maxRetriesFor(plan); attempt++) {
    try {
      const result = await runPhaseAgentAttempt({
        agentTool,
        phase,
        index,
        attempt,
        plan,
        context,
        canUseTool,
        assistantMessage,
        taskId,
        prompt,
        workflowAbortController,
        userRetryAttempt,
      })
      resumeRuntime.entries.push(recordResumeCacheEntry({
        index: agentIndex,
        identity,
        phase: phase.id,
        label: result.agentId,
        result,
      }))
      return { result, cacheHit: false }
    } catch (error) {
      if (workflowAbortController.signal.aborted) throw error
      const baseAgentId = workflowAgentName(plan, phase, index)
      const userRetryRequested = error instanceof Error && error.message === WORKFLOW_AGENT_USER_RETRY_ABORT_REASON
      if (userRetryRequested) {
        userRetryAttempt += 1
        attempt -= 1
        continue
      }
      const currentTask = context.getAppState().tasks[taskId]
      const physicalAttempt = attempt + userRetryAttempt
      const currentAgentId = currentTask?.type === 'local_workflow'
        ? currentTask.phases.find(currentPhase => currentPhase.id === phase.id)?.agentIds[index]
          ?? retryAgentId(baseAgentId, physicalAttempt)
        : retryAgentId(baseAgentId, physicalAttempt)
      const currentResult = currentTask?.type === 'local_workflow'
        ? currentTask.phases.find(currentPhase => currentPhase.id === phase.id)?.results.find(result => result.index === index)
        : undefined
      if (currentResult?.status === 'skipped') {
        return { result: currentResult, cacheHit: false }
      }
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      failWorkflowAgent({
        taskId,
        phaseId: phase.id,
        agentId: currentAgentId,
        index,
        error: message,
        setAppState: context.setAppStateForTasks ?? context.setAppState,
      })
      lastFailedResult = {
        phaseId: phase.id,
        agentId: currentAgentId,
        index,
        status: 'failed',
        error: message,
      }
    }
  }
  if (lastFailedResult) return { result: lastFailedResult, cacheHit: false }
  throw lastError
}

export async function runWorkflowPlan({
  plan,
  context,
  canUseTool,
  assistantMessage,
  runArgs,
  workflowRunId = createWorkflowRunId(),
  scriptPath = plan.sourcePath,
  resumeFromRunId,
  injectRunArgsIntoRootPrompt = true,
}: {
  plan: WorkflowDryRunPlan
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  runArgs?: WorkflowArgs
  workflowRunId?: string
  scriptPath?: string
  resumeFromRunId?: string
  injectRunArgsIntoRootPrompt?: boolean
}): Promise<string> {
  if (plan.totalAgents === 0 && plan.scriptResult !== undefined) {
    return typeof plan.scriptResult === 'string'
      ? plan.scriptResult
      : JSON.stringify(plan.scriptResult)
  }

  const agentTool = findAgentTool(context.options.tools)
  if (!agentTool) {
    throw new Error('Workflow execution requires the Agent tool')
  }

  const setAppState = context.setAppStateForTasks ?? context.setAppState
  const teamName = plan.defaults.execution === 'team' ? workflowTeamName(context) : undefined
  const workflowTask = registerWorkflowTask({
    plan,
    setAppState,
    toolUseId: context.toolUseId,
    runArgs,
    teamName,
    workflowRunId,
    scriptPath,
    defaultModel: context.options.mainLoopModel,
  })
  const cwd = workflowCwd(context)
  let runSession = await startWorkflowRunSession({
    cwd,
    taskId: workflowTask.id,
    plan,
    runArgs,
    workflowRunId,
    scriptPath,
    resumeFromRunId,
  })
  const priorSession = resumeFromRunId
    ? await loadWorkflowRunSession({ cwd, workflowRunId: resumeFromRunId })
    : undefined
  const resumeRuntime: WorkflowResumeRuntime = {
    cursor: createWorkflowResumeCursor(priorSession?.resumeCacheEntries ?? []),
    entries: [],
  }
  const resultsByPhase = new Map<string, WorkflowAgentResult[]>()
  let globalAgentIndex = 0

  const launchEnvelope = [
    `Workflow launched in background. Task ID: ${workflowTask.id}`,
    `Run ID: ${workflowRunId}`,
    ...(scriptPath
      ? [`To resume after editing the script: Workflow({scriptPath: "${scriptPath}", resumeFromRunId: "${workflowRunId}"}) — completed agents return cached results.`]
      : []),
    'Use /workflows to watch live progress.',
  ].join('\n')

  const emit = async (event: WorkflowProgressEvent): Promise<void> => {
    runSession = await emitWorkflowEvent({
      cwd,
      session: runSession,
      taskId: workflowTask.id,
      event,
      setAppState,
    })
  }

  const workflowRun = (async () => {
    try {
      await emit(createWorkflowProgressEvent({
        workflowRunId,
        status: 'running',
        completedAgents: 0,
        totalAgents: plan.totalAgents,
      }))
    await emit(createWorkflowLogEvent({
      workflowRunId,
      message: `Workflow started: ${plan.name}`,
    }))

    for (const phase of workflowPhaseExecutionOrder(plan.phases)) {
      startWorkflowPhase(workflowTask.id, phase.id, setAppState)
      await emit(createWorkflowPhaseEvent({
        workflowRunId,
        phaseId: phase.id,
        status: 'running',
      }))
      const results: WorkflowAgentResult[] = []
      for (let index = 0; index < phase.fanout; index += phase.concurrency) {
        const batchIndexes = Array.from(
          { length: Math.min(phase.concurrency, phase.fanout - index) },
          (_, offset) => index + offset,
        )
        const batchRuns = batchIndexes.map(batchIndex => ({
          batchIndex,
          agentIndex: globalAgentIndex++,
        }))
        const batchSettled = await Promise.allSettled(
          batchRuns.map(batchRun =>
            runPhaseAgent({
              agentTool,
              phase,
              index: batchRun.batchIndex,
              agentIndex: batchRun.agentIndex,
              plan,
              context,
              canUseTool,
              assistantMessage,
              taskId: workflowTask.id,
              workflowAbortController: workflowTask.abortController!,
              resultsByPhase,
              resumeRuntime,
              runArgs,
              injectRunArgsIntoRootPrompt,
            }),
          ),
        )
        if (workflowTask.abortController?.signal.aborted) {
          throw new Error('Workflow aborted')
        }
        const batchResults = batchSettled.flatMap(result =>
          result.status === 'fulfilled' ? [result.value] : [],
        )
        results.push(...batchResults.map(batchResult => batchResult.result))
        for (const batchResult of batchResults) {
          await emit(createWorkflowAgentEvent({
            workflowRunId,
            phaseId: phase.id,
            agentId: batchResult.result.agentId,
            status: batchResult.result.status,
            cacheHit: batchResult.cacheHit || undefined,
          }))
        }
        runSession = await updateWorkflowRunSessionProgress({
          cwd,
          session: runSession,
          results: [...resultsByPhase.values()].flat().concat(results),
          resumeCacheEntries: resumeRuntime.entries,
        })
      }
      resultsByPhase.set(phase.id, results)
      const hasFailedResults = results.some(result => result.status === 'failed')
      if (hasFailedResults) {
        await emit(createWorkflowPhaseEvent({
          workflowRunId,
          phaseId: phase.id,
          status: 'failed',
        }))
        throw new Error(`Workflow phase "${phase.id}" failed`)
      }
      await emit(createWorkflowPhaseEvent({
        workflowRunId,
        phaseId: phase.id,
        status: 'completed',
      }))
      await emit(createWorkflowProgressEvent({
        workflowRunId,
        status: 'running',
        completedAgents: [...resultsByPhase.values()].flat().length,
        totalAgents: plan.totalAgents,
      }))
    }
    const allResults = [...resultsByPhase.values()].flat()
    completeWorkflowTask(workflowTask.id, setAppState)
    await emit(createWorkflowProgressEvent({
      workflowRunId,
      status: 'completed',
      completedAgents: allResults.length,
      totalAgents: plan.totalAgents,
    }))
      await completeWorkflowRunSession({
        cwd,
        session: runSession,
        results: allResults,
        resumeCacheEntries: resumeRuntime.entries,
      })
      const resultText = allResults.map(result => `## ${result.agentId}\n${result.output ?? result.error ?? result.status}`).join('\n\n') || `Workflow completed. ${allResults.length} agents.`
      const outputFile = await writeWorkflowResult(
        workflowTask.id,
        resultText,
      )
      const summary = `Dynamic workflow "${plan.description}" completed`
      enqueueWorkflowCompletionNotification({
        taskId: workflowTask.id,
        toolUseId: context.toolUseId,
        summary,
        outputFile,
        resultText,
      })
      emitTaskTerminatedSdk(workflowTask.id, 'completed', {
        toolUseId: context.toolUseId,
        summary,
        outputFile,
        usage: {
          total_tokens: allResults.reduce((sum, result) => sum + (result.tokenCount ?? 0), 0),
          tool_uses: allResults.reduce((sum, result) => sum + (result.toolUseCount ?? 0), 0),
          duration_ms: Date.now() - workflowTask.startTime,
        },
      })
    } catch (error) {
    const abortStatus = workflowAbortStatus(workflowTask.abortController?.signal.reason)
    const allResults = [...resultsByPhase.values()].flat()
      if (abortStatus) {
        await updateWorkflowRunSessionProgress({
          cwd,
          session: runSession,
          results: allResults,
          resumeCacheEntries: resumeRuntime.entries,
        })
        await updateWorkflowRunSessionStatus({
          cwd,
          workflowRunId,
          status: abortStatus,
          ...(abortStatus === 'paused'
            ? { resumePrompt: workflowResumeCall({ ...workflowTask, workflowRunId, scriptPath }) }
            : {}),
        })
        return
      }

      // Abort remaining agents on workflow failure
      workflowTask.abortController?.abort()
      const message = error instanceof Error ? error.message : String(error)
      failWorkflowTask(workflowTask.id, message, setAppState)
      await emit(createWorkflowProgressEvent({
        workflowRunId,
        status: 'failed',
        completedAgents: allResults.length,
        totalAgents: plan.totalAgents,
      }))
      await failWorkflowRunSession({
        cwd,
        session: runSession,
        results: allResults,
        error: message,
        resumeCacheEntries: resumeRuntime.entries,
      })
      const outputFile = await writeWorkflowResult(workflowTask.id, message)
      emitTaskTerminatedSdk(workflowTask.id, 'failed', {
        toolUseId: context.toolUseId,
        summary: `Dynamic workflow "${plan.description}" failed: ${message}`,
        outputFile,
        usage: {
          total_tokens: allResults.reduce((sum, result) => sum + (result.tokenCount ?? 0), 0),
          tool_uses: allResults.reduce((sum, result) => sum + (result.toolUseCount ?? 0), 0),
          duration_ms: Date.now() - workflowTask.startTime,
        },
      })
    }
  })()

  if (context.options.workflowRunInForeground) {
    await workflowRun
  }
  return launchEnvelope
}
