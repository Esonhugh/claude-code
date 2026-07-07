import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { AssistantMessage, NormalizedUserMessage } from '../../types/message.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
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
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'

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
  agentId?: string
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
  tokenCount: number
  toolUseCount: number
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
      ? { tokenCount: 0, toolUseCount: 0, prompt: prompt.trim() }
      : undefined
  }
  if ((message as { type?: unknown }).type === 'user') {
    const activity = commandActivityFromUser(message as NormalizedUserMessage)
    return typeof prompt === 'string' && prompt.trim() !== '' || activity
      ? {
          tokenCount: 0,
          toolUseCount: activity ? 1 : 0,
          prompt: typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : undefined,
          activities: activity ? [activity] : undefined,
        }
      : undefined
  }
  if ((message as { type?: unknown }).type !== 'assistant') {
    return typeof prompt === 'string' && prompt.trim() !== ''
      ? { tokenCount: 0, toolUseCount: 0, prompt: prompt.trim() }
      : undefined
  }
  const assistant = message as AssistantMessage
  const tokenCount =
    assistant.message.usage.input_tokens +
    assistant.message.usage.output_tokens +
    (assistant.message.usage.cache_creation_input_tokens ?? 0) +
    (assistant.message.usage.cache_read_input_tokens ?? 0)
  const toolUseCount = assistant.message.content.filter(block => block.type === 'tool_use').length
  return {
    tokenCount,
    toolUseCount,
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
  if (label) return label
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

function resultAgentId(output: AgentToolOutput, fallback: string): string {
  return output.agentId || fallback
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
  if (userRetryAttempt > 0) return `${base} retry ${userRetryAttempt}`
  return attempt === 0 ? base : `${base} retry ${attempt}/${maxRetriesFor(plan)}`
}

function userRetryAgentId(baseAgentId: string, userRetryAttempt: number): string {
  return userRetryAttempt > 0 ? `${baseAgentId} (retry ${userRetryAttempt})` : baseAgentId
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
  const fallbackAgentId = userRetryAttempt > 0
    ? userRetryAgentId(baseAgentId, userRetryAttempt)
    : attempt === 0 ? baseAgentId : `${baseAgentId}-retry-${attempt}`
  recordWorkflowAgentStarted({
    taskId,
    phaseId: phase.id,
    agentId: fallbackAgentId,
    setAppState: context.setAppStateForTasks ?? context.setAppState,
  })
  const progressStartTime = Date.now()
  let progressTokens = 0
  let progressToolUses = 0
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
      progressTokens += metrics.tokenCount
      progressToolUses += metrics.toolUseCount
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
      const activities = metrics.activities?.length ? metrics.activities : [undefined]
      for (const activity of activities) {
        recordWorkflowAgentProgress({
          taskId,
          agentId: fallbackAgentId,
          tokenCount: metrics.tokenCount,
          toolUseCount: activity ? 1 : metrics.toolUseCount,
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
    throw error
  } finally {
    clearInterval(stallTimer)
  }
  const output = result.data as AgentToolOutput
  const agentId = resultAgentId(output, fallbackAgentId)
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
    tokenCount: output.totalTokens ?? 0,
    toolUseCount: output.totalToolUseCount ?? 0,
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
      const currentAgentId = userRetryAttempt > 0
        ? userRetryAgentId(baseAgentId, userRetryAttempt)
        : attempt === 0 ? baseAgentId : `${baseAgentId}-retry-${attempt}`
      const task = context.getAppState().tasks?.[taskId]
      const userRetryRequested = task?.type === 'local_workflow' && task.agentControllers?.[currentAgentId] === undefined
      if (userRetryRequested) {
        userRetryAttempt += 1
        attempt -= 1
        continue
      }
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      failWorkflowAgent({
        taskId,
        phaseId: phase.id,
        agentId: currentAgentId,
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
      resumeRuntime.entries.push(recordResumeCacheEntry({
        index: agentIndex,
        identity,
        phase: phase.id,
        label: currentAgentId,
        result: lastFailedResult,
      }))
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
      const outputFile = await writeWorkflowResult(
        workflowTask.id,
        allResults.map(result => `## ${result.agentId}\n${result.output ?? result.error ?? result.status}`).join('\n\n') || `Workflow completed. ${allResults.length} agents.`,
      )
      emitTaskTerminatedSdk(workflowTask.id, 'completed', {
        toolUseId: context.toolUseId,
        summary: `Dynamic workflow "${plan.description}" completed`,
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
