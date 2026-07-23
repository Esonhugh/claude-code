import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { AssistantMessage } from '../../types/message.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
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
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {
  LocalWorkflowTaskState,
  WorkflowAgentErrorKind,
  WorkflowAgentResult,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowArgs, WorkflowDryRunPhase, WorkflowDryRunPlan, WorkflowPermissionMode, WorkflowProgressEvent } from './workflowSpec.js'
import { createWorkflowScriptAgentChainIdentity, type WorkflowResumeCacheEntry } from './workflowResumeCache.js'
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
  startWorkflowRunSession,
  updateWorkflowRunSessionProgress,
  updateWorkflowRunSessionStatus,
} from './workflowRunSessions.js'
import { createWorkflowRunId, resolveWorkflowScriptPath } from './workflowScriptPersistence.js'
import { hasWorkflowScriptMeta, parseWorkflowScript, workflowErrorMessage } from './workflowScriptParser.js'
import { getCwd } from '../../utils/cwd.js'
import { emitTaskProgress } from '../../utils/task/sdkProgress.js'
import {
  createProgressTracker,
  getProgressUpdate,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { getProjectTempDir } from '../../utils/permissions/filesystem.js'
import {
  appendWorkflowJournalResult,
  appendWorkflowJournalStarted,
} from './workflowJournal.js'
import { loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'
import { loadWorkflowScriptSpec } from './workflowDsl.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'
import { workflowPhaseExecutionOrder } from './workflowPhaseScheduler.js'
import { createSyntheticOutputTool } from '../SyntheticOutputTool/SyntheticOutputTool.js'
import { snapshotWorkflowAgentContext } from './runWorkflow.js'

// --- Constants ---
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const MAX_LOGS = 1000
const SYNC_TIMEOUT_MS = 5000
const MAX_CONCURRENCY = Math.min(16, Math.max(2, availableParallelism() - 2))
const DEFAULT_STALL_MS = 120_000
const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'

export function classifyWorkflowAgentError(
  error: unknown,
): WorkflowAgentErrorKind {
  const message = error instanceof Error ? error.message : String(error)
  if (/Concurrency limit exceeded for user/i.test(message)) {
    return 'concurrency_limit'
  }
  if (/stalled/i.test(message)) {
    return 'stalled'
  }
  if (/permission denied|not allowed|denied by permission/i.test(message)) {
    return 'permission_denied'
  }
  return 'agent_failed'
}

// --- Types ---
type AgentToolInput = {
  description: string
  prompt: string
  subagent_type?: string
  model?: 'sonnet' | 'opus' | 'haiku'
  mode?: WorkflowPermissionMode
  isolation?: 'worktree'
}

type AgentToolOutput = {
  status?: string
  agentId?: string
  content?: Array<{ type: string; text?: string }>
  totalTokens?: number
  totalToolUseCount?: number
  totalDurationMs?: number
  structured_output?: unknown
}

type AgentOpts = {
  label?: string
  phase?: string
  schema?: object
  model?: string
  agentType?: string
  mode?: WorkflowPermissionMode
  isolation?: 'worktree'
  stallMs?: number
}


export type WorkflowScriptResult = {
  result: unknown
  agentCount: number
  logs: string[]
  error?: string
}

// --- Semaphore ---
class Semaphore {
  private queue: Array<{
    resolve: (acquired: boolean) => void
    signal: AbortSignal
    onAbort: () => void
  }> = []
  private active = 0
  constructor(private max: number) {}
  async acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    if (this.active < this.max) {
      this.active++
      return true
    }
    return await new Promise<boolean>(resolve => {
      const onAbort = () => {
        const index = this.queue.findIndex(entry => entry.onAbort === onAbort)
        if (index >= 0) this.queue.splice(index, 1)
        resolve(false)
      }
      this.queue.push({ resolve, signal, onAbort })
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) {
      next.signal.removeEventListener('abort', next.onAbort)
      this.active++
      next.resolve(true)
    }
  }
}

// --- Journal (Resume Cache) ---
class WorkflowJournal {
  private entriesByIdentity = new Map<string, WorkflowResumeCacheEntry[]>()
  private recordedEntries: WorkflowResumeCacheEntry[] = []
  record(identity: string, result: unknown, input: { index: number; phase?: string; label?: string; completedAt?: number }): void {
    this.recordedEntries.push({
      index: input.index,
      identity,
      phase: input.phase,
      label: input.label,
      result,
      completedAt: input.completedAt ?? Date.now(),
    })
  }
  lookup(identity: string): { hit: true; result: unknown } | { hit: false } {
    const entries = this.entriesByIdentity.get(identity)
    const entry = entries?.shift()
    if (entry) return { hit: true, result: entry.result }
    return { hit: false }
  }
  entries(): WorkflowResumeCacheEntry[] {
    return this.recordedEntries
  }
  loadFrom(entries: WorkflowResumeCacheEntry[]): void {
    for (const entry of entries) {
      const matches = this.entriesByIdentity.get(entry.identity) ?? []
      matches.push(entry)
      this.entriesByIdentity.set(entry.identity, matches)
    }
  }
}

function defineSandboxGlobal(sandbox: vm.Context, name: string, value: unknown): void {
  Object.defineProperty(sandbox, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

function serializeWorkflowScriptResult(scriptResult: unknown, fallback: string): string {
  if (scriptResult == null) return fallback
  if (typeof scriptResult === 'string') return scriptResult
  const serialized = JSON.stringify(scriptResult, null, 2)
  if (serialized === undefined) throw new Error('workflow result cannot be serialized')
  return serialized
}

// --- Helpers ---
function findAgentTool(tools: readonly Tool[]): Tool | undefined {
  return tools.find(
    tool => AGENT_TOOL_NAMES.has(tool.name) || tool.aliases?.some(alias => AGENT_TOOL_NAMES.has(alias)),
  )
}

function extractAgentText(output: AgentToolOutput): string {
  return (
    output.content
      ?.map(b => (b.type === 'text' ? b.text ?? '' : ''))
      .filter(Boolean)
      .join('\n')
      .trim() || output.status || 'completed'
  )
}

// --- StructuredOutput schema prompt ---
function buildSchemaPrompt(schema: object): string {
  return (
    '\n\nYou MUST call the `' + STRUCTURED_OUTPUT_TOOL_NAME + '` tool exactly once to return your answer.\n' +
    'The tool input must match this JSON Schema:\n```json\n' +
    JSON.stringify(schema, null, 2) +
    '\n```\n' +
    'Do NOT put your answer in a text response. The script reads ONLY the tool call.\n' +
    'If schema validation fails, read the error and call the tool again with corrected input.'
  )
}

function workflowProgressSnapshot(
  plan: WorkflowDryRunPlan,
  task?: LocalWorkflowTaskState,
): Array<{
  type: string
  index: number
  phaseIndex?: number
  label?: string
  status?: string
  message?: string
}> {
  return plan.phases.flatMap((phase, phaseIndex) => {
    const phaseState = task?.phases.find(item => item.id === phase.id)
    const labels = phaseState?.agentIds.length
      ? phaseState.agentIds
      : Array.from(
          { length: phase.fanout },
          (_, index) => phase.agentLabels?.[index] ?? `${phase.id}-${index + 1}`,
        )
    return [
      {
        type: 'phase',
        index: phaseIndex,
        label: phase.id,
        status: phaseState?.status ?? 'pending',
        message: phase.description,
      },
      ...labels.map((label, index) => ({
        type: 'agent',
        index,
        phaseIndex,
        label,
        status: phaseState?.completedAgentIds.includes(label)
          ? 'completed'
          : phaseState?.failedAgentIds.includes(label)
            ? 'failed'
            : phaseState?.skippedAgentIds.includes(label)
              ? 'skipped'
              : phaseState?.agentIds.includes(label)
                ? 'running'
                : 'pending',
      })),
    ]
  })
}

function workflowAgentProgressDescription(phase: string, label: string, plan: WorkflowDryRunPlan): string {
  const isChildWorkflowAgent = !plan.phases.some(item => item.id === phase)
  return isChildWorkflowAgent ? `▸ ${phase}: ${label}` : `${phase}: ${label}`
}

function workflowTranscriptDir(workflowRunId: string): string {
  return join(getProjectTempDir(), 'workflow-runs', workflowRunId)
}

function workflowLaunchEnvelope({
  taskId,
  summary,
  transcriptDir,
  scriptPath,
  workflowRunId,
}: {
  taskId: string
  summary: string
  transcriptDir: string
  scriptPath?: string
  workflowRunId: string
}): string {
  const scriptFile = scriptPath ?? '<script file unavailable>'
  return [
    `Workflow launched in background. Task ID: ${taskId}`,
    `Summary: ${summary}`,
    `Transcript dir: ${transcriptDir}`,
    `Script file: ${scriptFile}`,
    `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${scriptFile}"} to iterate without resending the script.)`,
    `Run ID: ${workflowRunId}`,
    `To resume after editing the script: Workflow({scriptPath: "${scriptFile}", resumeFromRunId: "${workflowRunId}"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).`,
    '',
    'You will be notified when it completes. Use /workflows to watch live progress.',
  ].join('\n')
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

function enqueueWorkflowNotification({
  taskId,
  toolUseId,
  status,
  summary,
  outputFile,
  resultText,
}: {
  taskId: string
  toolUseId?: string
  status: 'completed' | 'failed'
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
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXmlText(summary)}</${SUMMARY_TAG}>
<result>${truncatedResult}</result>
</${TASK_NOTIFICATION_TAG}>`
  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

function workflowAbortStatus(reason: unknown): 'paused' | 'killed' | undefined {
  if (reason === 'workflow-paused') return 'paused'
  if (reason === 'workflow-killed') return 'killed'
  return undefined
}

// --- Main Runtime ---
export async function runWorkflowScript({
  script,
  plan,
  args,
  context,
  canUseTool,
  assistantMessage,
  workflowRunId = createWorkflowRunId(),
  scriptPath,
  budgetTotal,
  resumeFromRunId,
  resumeJournalEntries,
}: {
  script: string
  plan: WorkflowDryRunPlan
  args?: WorkflowArgs
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  workflowRunId?: string
  scriptPath?: string
  budgetTotal?: number | null
  resumeFromRunId?: string
  resumeJournalEntries?: WorkflowResumeCacheEntry[]
}): Promise<string> {
  const agentTool = findAgentTool(context.options.tools)
  if (!agentTool) throw new Error('Workflow script execution requires the Agent tool')

  const setAppState = context.setAppStateForTasks ?? context.setAppState
  const workflowTask = registerWorkflowTask({
    plan,
    setAppState,
    toolUseId: context.toolUseId,
    runArgs: args,
    workflowRunId,
    scriptPath,
    defaultModel: context.options.mainLoopModel,
    dynamicAgentCount: true,
  })
  const cwd = 'getCwd' in context && typeof context.getCwd === 'function'
    ? context.getCwd() : getCwd()

  const transcriptDir = workflowTranscriptDir(workflowRunId)
  let runSession = await startWorkflowRunSession({
    cwd,
    taskId: workflowTask.id,
    plan,
    runArgs: args,
    workflowRunId,
    scriptPath,
    transcriptDir,
    resumeFromRunId,
  })

  const logs: string[] = []
  let agentCount = 0
  let tokenSpent = 0
  let toolUseSpent = 0
  let currentPhaseId = plan.phases[0]?.id ?? plan.name
  let childWorkflowProgressName: string | undefined
  const abortController = workflowTask.abortController!
  const semaphore = new Semaphore(MAX_CONCURRENCY)
  const journal = new WorkflowJournal()
  if (resumeJournalEntries) journal.loadFrom(resumeJournalEntries)
  const scriptAgentResults: WorkflowAgentResult[] = []
  const agentLabelOccurrences = new Map<string, number>()
  const assignedAgentIds = new Set<string>()
  const phaseAgentCounts = new Map<string, number>()
  let workflowAgentIdentitySeed = ''
  const workflowAgentIdentityScope = new AsyncLocalStorage<{ seed: string }>()
  const currentWorkflowProgress = () => {
    const task = context.getAppState().tasks[workflowTask.id]
    return workflowProgressSnapshot(
      plan,
      task?.type === 'local_workflow' ? task : undefined,
    )
  }

  const emit = async (event: WorkflowProgressEvent): Promise<void> => {
    recordWorkflowEvent({ taskId: workflowTask.id, event, setAppState })
    runSession = await appendWorkflowRunEvent({ cwd, session: runSession, event })
  }

  // --- Budget ---
  const budget = {
    total: budgetTotal ?? null,
    spent: () => tokenSpent,
    remaining: () => budgetTotal == null ? Infinity : Math.max(0, budgetTotal - tokenSpent),
  }
  function checkBudget() {
    if (budget.total !== null && tokenSpent >= budget.total) {
      throw new Error('WorkflowBudgetExceededError: token budget exhausted')
    }
  }
  // --- Real agent() with stall detection, retry, schema, worktree ---
  async function realAgent(
    prompt: string,
    opts?: AgentOpts,
  ): Promise<unknown> {
    if (abortController.signal.aborted) return null
    checkBudget()

    const requestedAgentId = opts?.label || `agent-${agentCount + 1}`
    let labelOccurrence = agentLabelOccurrences.get(requestedAgentId) ?? 0
    let agentId = labelOccurrence === 0
      ? requestedAgentId
      : `${requestedAgentId} [${labelOccurrence + 1}]`
    while (assignedAgentIds.has(agentId)) {
      labelOccurrence++
      agentId = `${requestedAgentId} [${labelOccurrence + 1}]`
    }
    agentLabelOccurrences.set(requestedAgentId, labelOccurrence + 1)
    assignedAgentIds.add(agentId)
    const logicalAgentId = agentId
    const phase = opts?.phase || currentPhaseId
    const phaseAgentIndex = phaseAgentCounts.get(phase) ?? 0
    phaseAgentCounts.set(phase, phaseAgentIndex + 1)
    const agentLaunch = snapshotWorkflowAgentContext(
      opts?.mode ?? plan.defaults.permissionMode,
      context,
    )
    const identityScope = workflowAgentIdentityScope.getStore()
    const identityKey = createWorkflowScriptAgentChainIdentity({
      previousKey: identityScope?.seed ?? workflowAgentIdentitySeed,
      prompt,
      opts: {
        schema: opts?.schema,
        model: opts?.model,
        isolation: opts?.isolation,
        agentType: opts?.agentType,
        label: logicalAgentId,
        mode: agentLaunch.identityMode,
        phase,
      },
    })
    if (identityScope) identityScope.seed = identityKey
    else workflowAgentIdentitySeed = identityKey
    agentCount++

    startWorkflowPhase(workflowTask.id, phase, setAppState)

    await appendWorkflowJournalStarted(transcriptDir, {
      key: identityKey,
      agentId: agentId,
      logicalAgentId,
      attemptId: `${phase}:${logicalAgentId}:attempt:0`,
      attempt: 0,
      phase,
      label: agentId,
      index: phaseAgentIndex,
      timestamp: Date.now(),
    })

    // Journal cache hit
    const cached = journal.lookup(identityKey)
    if (cached.hit) {
      recordWorkflowAgentStarted({
        taskId: workflowTask.id,
        phaseId: phase,
        agentId: agentId,
        logicalAgentId,
        attempt: 0,
        recordAttempt: false,
        index: phaseAgentIndex,
        setAppState,
      })
      const output = typeof cached.result === 'string'
        ? cached.result
        : JSON.stringify(cached.result) ?? String(cached.result)
      const cachedAgentResult: WorkflowAgentResult = {
        phaseId: phase,
        agentId: agentId,
        index: phaseAgentIndex,
        status: 'completed',
        output,
        prompt,
        tokenCount: 0,
        toolUseCount: 0,
        durationMs: 0,
      }
      scriptAgentResults.push(cachedAgentResult)
      completeWorkflowAgent({
        taskId: workflowTask.id,
        result: cachedAgentResult,
        setAppState,
      })
      await appendWorkflowJournalResult(transcriptDir, {
        key: identityKey,
        agentId: agentId,
        phase,
        label: agentId,
        index: phaseAgentIndex,
        status: 'completed',
        logicalAgentId,
        attemptId: `${phase}:${logicalAgentId}:attempt:0`,
        attempt: 0,
        result: cached.result,
        timestamp: Date.now(),
      })
      await emit(createWorkflowAgentEvent({ workflowRunId, phaseId: phase, agentId: agentId, status: 'completed', cacheHit: true }))
      return cached.result
    }

    const stallMs = opts?.stallMs ?? DEFAULT_STALL_MS

    // Stall/user retry loop
    let attempt = 0
    let automaticRetries = 0
    while (true) {
      const attemptAgentId = attempt === 0 ? agentId : `${agentId} (retry ${attempt})`
      const attemptId = `${phase}:${logicalAgentId}:attempt:${attempt}`
      const retryOfAttemptId = attempt > 0
        ? `${phase}:${logicalAgentId}:attempt:${attempt - 1}`
        : undefined
      recordWorkflowAgentStarted({
        taskId: workflowTask.id,
        phaseId: phase,
        agentId: attemptAgentId,
        logicalAgentId,
        attempt,
        retryOfAttemptId,
        index: phaseAgentIndex,
        setAppState,
      })
      if (attempt > 0) {
        await appendWorkflowJournalStarted(transcriptDir, {
          key: identityKey,
          agentId: attemptAgentId,
          logicalAgentId,
          attemptId,
          attempt,
          retryOfAttemptId,
          phase,
          label: agentId,
          index: phaseAgentIndex,
          timestamp: Date.now(),
        })
      }

      const acquired = await semaphore.acquire(abortController.signal)
      if (!acquired) return null
      try {
        const result = await runSingleAgent(
          prompt,
          opts,
          agentLaunch.inputMode,
          agentLaunch.context,
          attemptAgentId,
          logicalAgentId,
          attempt,
          phase,
          stallMs,
          phaseAgentIndex,
        )
        const completedAt = Date.now()
        const currentTask = context.getAppState().tasks[workflowTask.id]
        const completedResult = currentTask?.type === 'local_workflow'
          ? currentTask.results.find(
              current => current.phaseId === phase && current.index === phaseAgentIndex,
            )
          : undefined
        scriptAgentResults.push(completedResult ?? {
          phaseId: phase,
          agentId: attemptAgentId,
          index: phaseAgentIndex,
          status: 'completed',
          output: typeof result === 'string' ? result : JSON.stringify(result) ?? String(result),
          prompt,
        })
        journal.record(identityKey, result, { index: phaseAgentIndex, phase, label: agentId, completedAt })
        await appendWorkflowJournalResult(transcriptDir, {
          key: identityKey,
          agentId: attemptAgentId,
          logicalAgentId,
          attemptId,
          attempt,
          retryOfAttemptId,
          phase,
          label: agentId,
          index: phaseAgentIndex,
          status: 'completed',
          result,
          timestamp: completedAt,
        })
        return result
      } catch (error) {
        if (abortController.signal.aborted) return null
        const msg = workflowErrorMessage(error, `Workflow agent failed without error details: ${attemptAgentId}`)
        const userRetryRequested = msg === WORKFLOW_AGENT_USER_RETRY_ABORT_REASON
        const automaticRetryRequested = msg.includes('stalled') && automaticRetries < plan.defaults.maxRetries
        if (userRetryRequested || automaticRetryRequested) {
          await appendWorkflowJournalResult(transcriptDir, {
            key: identityKey,
            agentId: attemptAgentId,
            logicalAgentId,
            attemptId,
            attempt,
            retryOfAttemptId,
            phase,
            label: agentId,
            index: phaseAgentIndex,
            status: 'interrupted',
            error: msg,
            result: null,
            timestamp: Date.now(),
          })
          if (automaticRetryRequested) automaticRetries++
          attempt++
          logs.push(`[retry] agent "${agentId}" retry ${attempt}${automaticRetryRequested ? `/${plan.defaults.maxRetries}` : ''}`)
          continue
        }
        if (msg === WORKFLOW_AGENT_SKIPPED_ABORT_REASON) {
          scriptAgentResults.push({
            phaseId: phase,
            agentId: attemptAgentId,
            index: phaseAgentIndex,
            status: 'skipped',
            prompt,
          })
          await appendWorkflowJournalResult(transcriptDir, {
            key: identityKey,
            agentId: attemptAgentId,
            logicalAgentId,
            attemptId,
            attempt,
            retryOfAttemptId,
            phase,
            label: agentId,
            index: phaseAgentIndex,
            status: 'skipped',
            result: null,
            timestamp: Date.now(),
          })
          return null
        }
        // Non-stall error or max retries — fail gracefully (return null like official parallel)
        const errorKind = classifyWorkflowAgentError(error)
        failWorkflowAgent({
          taskId: workflowTask.id, phaseId: phase, agentId: attemptAgentId,
          index: phaseAgentIndex, error: msg, errorKind, setAppState,
        })
        scriptAgentResults.push({
          phaseId: phase,
          agentId: attemptAgentId,
          index: phaseAgentIndex,
          status: 'failed',
          error: msg,
          errorKind,
          prompt,
        })
        await appendWorkflowJournalResult(transcriptDir, {
          key: identityKey,
          agentId: attemptAgentId,
          logicalAgentId,
          attemptId,
          attempt,
          retryOfAttemptId,
          phase,
          label: agentId,
          index: phaseAgentIndex,
          status: 'failed',
          error: msg,
          errorKind,
          result: null,
          timestamp: Date.now(),
        })
        return null
      } finally {
        semaphore.release()
      }
    }
    return null
  }

  async function runSingleAgent(
    prompt: string, opts: AgentOpts | undefined,
    permissionMode: WorkflowPermissionMode | undefined,
    agentContext: ToolUseContext,
    agentId: string, logicalAgentId: string, attempt: number,
    phase: string, stallMs: number, phaseAgentIndex: number,
  ): Promise<unknown> {
    const agentAbortController = createChildAbortController(abortController)
    const attemptId = `${phase}:${logicalAgentId}:attempt:${attempt}`
    recordWorkflowAgentController({
      taskId: workflowTask.id, agentId,
      abortController: agentAbortController, setAppState,
      logicalAgentId, attempt, attemptId, index: phaseAgentIndex,
    })

    // Stall timer
    let lastProgress = Date.now()
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgress > stallMs) {
        agentAbortController.abort('stalled')
      }
    }, Math.min(stallMs / 2, 30_000))

    const description = `${plan.name}: ${agentId}`
    const schemaPrompt = opts?.schema ? buildSchemaPrompt(opts.schema) : ''
    const structuredOutputResult = opts?.schema
      ? createSyntheticOutputTool(opts.schema as Record<string, unknown>)
      : undefined
    if (structuredOutputResult && 'error' in structuredOutputResult) {
      throw new Error(`Invalid workflow agent schema: ${structuredOutputResult.error}`)
    }
    const structuredOutputTool = structuredOutputResult && 'tool' in structuredOutputResult
      ? structuredOutputResult.tool
      : undefined

    const input: AgentToolInput = {
      description,
      prompt: prompt + schemaPrompt,
      subagent_type: opts?.agentType,
      model: opts?.model as AgentToolInput['model'],
      mode: permissionMode,
      ...(opts?.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
    }

    try {
      const progressPhase = childWorkflowProgressName ?? phase
      const progressTracker = createProgressTracker()
      let progressTokens = 0
      let progressToolUses = 0
      emitTaskProgress({
        taskId: workflowTask.id,
        toolUseId: context.toolUseId,
        description: workflowAgentProgressDescription(progressPhase, agentId, plan),
        startTime: workflowTask.startTime,
        totalTokens: tokenSpent,
        toolUses: 0,
        lastToolName: agentId,
        summary: `Workflow agent started: ${agentId}`,
        workflowProgress: currentWorkflowProgress(),
      })

      const result = await agentTool.call(
        input as never,
        {
          ...agentContext,
          abortController: agentAbortController,
          options: {
            ...agentContext.options,
            tools: structuredOutputTool
              ? [
                  ...agentContext.options.tools.filter(
                    tool => tool.name !== STRUCTURED_OUTPUT_TOOL_NAME,
                  ),
                  structuredOutputTool,
                ]
              : agentContext.options.tools,
            disableNestedAgentTools: true,
          },
        },
        canUseTool, assistantMessage,
        (progress) => {
          lastProgress = Date.now()
          const data = progress?.data as
            | { type?: string; message?: unknown; summary?: string }
            | undefined
          let tokenDelta = 0
          let toolUseDelta = 0
          if (
            data?.type === 'agent_progress' &&
            data.message &&
            typeof data.message === 'object' &&
            (data.message as { type?: unknown }).type === 'assistant'
          ) {
            const previousTokens = progressTokens
            const previousToolUses = progressToolUses
            updateProgressFromMessage(
              progressTracker,
              data.message as AssistantMessage,
            )
            const update = getProgressUpdate(progressTracker)
            progressTokens = update.tokenCount
            progressToolUses = update.toolUseCount
            tokenDelta = progressTokens - previousTokens
            toolUseDelta = progressToolUses - previousToolUses
          }
          if (tokenDelta !== 0 || toolUseDelta !== 0 || data?.summary) {
            recordWorkflowAgentProgress({
              taskId: workflowTask.id, agentId: agentId,
              tokenCount: tokenDelta, toolUseCount: toolUseDelta,
              activity: data?.summary, prompt: prompt.slice(0, 200),
              setAppState,
            })
            emitTaskProgress({
              taskId: workflowTask.id,
              toolUseId: context.toolUseId,
              description: workflowAgentProgressDescription(progressPhase, agentId, plan),
              startTime: workflowTask.startTime,
              totalTokens: tokenSpent + progressTokens,
              toolUses: toolUseSpent + progressToolUses,
              lastToolName: agentId,
              summary: data?.summary ?? `Workflow agent running: ${agentId}`,
              workflowProgress: currentWorkflowProgress(),
            })
          }
        },
      )
      clearInterval(stallTimer)

      const output = result.data as AgentToolOutput
      if (agentAbortController.signal.reason === WORKFLOW_AGENT_USER_RETRY_ABORT_REASON) {
        throw new Error(WORKFLOW_AGENT_USER_RETRY_ABORT_REASON)
      }
      if (agentAbortController.signal.reason === WORKFLOW_AGENT_SKIPPED_ABORT_REASON) {
        throw new Error(WORKFLOW_AGENT_SKIPPED_ABORT_REASON)
      }
      if (output.status && output.status !== 'completed') {
        throw new Error(extractAgentText(output))
      }
      const text = extractAgentText(output)
      const finalTokens = output.totalTokens ?? progressTokens
      const finalToolUses = output.totalToolUseCount ?? progressToolUses
      tokenSpent += finalTokens
      toolUseSpent += finalToolUses

      const agentResult = opts?.schema
        ? output.structured_output
        : text || null
      if (opts?.schema && agentResult === undefined) {
        throw new Error(`Workflow agent ${agentId} did not return structured output`)
      }

      completeWorkflowAgent({
        taskId: workflowTask.id,
        result: {
          phaseId: phase, agentId: agentId, index: phaseAgentIndex,
          status: 'completed', output: typeof agentResult === 'string' ? agentResult : JSON.stringify(agentResult), prompt,
          tokenCount: finalTokens,
          toolUseCount: finalToolUses,
          durationMs: output.totalDurationMs ?? 0,
        },
        setAppState,
        attemptId,
      })

      emitTaskProgress({
        taskId: workflowTask.id,
        toolUseId: context.toolUseId,
        description: workflowAgentProgressDescription(progressPhase, agentId, plan),
        startTime: workflowTask.startTime,
        totalTokens: tokenSpent,
        toolUses: toolUseSpent,
        lastToolName: agentId,
        summary: `Workflow agent completed: ${agentId}`,
        workflowProgress: currentWorkflowProgress(),
      })

      return agentResult
    } catch (error) {
      clearInterval(stallTimer)
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
    }
  }

  // --- parallel(): Promise.allSettled, errors → null ---
  async function mapWithConcurrency<T, R>(
    items: T[],
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(items.length)
    let nextIndex = 0
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENCY, items.length) },
      async () => {
        while (!abortController.signal.aborted) {
          const index = nextIndex++
          if (index >= items.length) return
          results[index] = await mapper(items[index]!, index)
        }
      },
    )
    await Promise.all(workers)
    return results
  }

  // --- parallel(): bounded fan-out, errors → null ---
  async function realParallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>> {
    if (abortController.signal.aborted) return thunks.map(() => null)
    checkBudget()
    const parentSeed = workflowAgentIdentityScope.getStore()?.seed ?? workflowAgentIdentitySeed
    return mapWithConcurrency(thunks, (thunk, index) =>
      workflowAgentIdentityScope.run({ seed: parentSeed }, async () => {
        try {
          return await thunk()
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          logs.push(`parallel[${index}] failed: ${msg}`)
          return null
        }
      }),
    )
  }

  // --- pipeline(): no barrier between stages, per-item ---
  async function realPipeline<T>(items: T[], ...stages: Array<(val: any, orig: any, idx: number) => any>): Promise<any[]> {
    if (abortController.signal.aborted) return items.map(() => null)
    checkBudget()
    const parentSeed = workflowAgentIdentityScope.getStore()?.seed ?? workflowAgentIdentitySeed
    return mapWithConcurrency(items, (item, index) =>
      workflowAgentIdentityScope.run({ seed: parentSeed }, async () => {
        let value: unknown = item
        for (const stage of stages) {
          if (value === null) break
          try { value = await stage(value, item, index) }
          catch { value = null }
        }
        return value
      }),
    )
  }

  function childWorkflowNestingError(): Error {
    return new Error('workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.')
  }

  async function loadChildWorkflow(ref: string | { scriptPath: string }, subArgs?: WorkflowArgs): Promise<{ plan: WorkflowDryRunPlan; script?: string }> {
    if (typeof ref === 'string') {
      const workflow = await loadWorkflowSpecByNameOrPath(cwd, ref, subArgs, { childWorkflowDepth: 1 })
      return { plan: workflow.plan, script: workflow.spec.runScriptSnapshot }
    }
    const childCwd = scriptPath ? dirname(scriptPath) : cwd
    const childScriptPath = await resolveWorkflowScriptPath({ cwd: childCwd, scriptPath: ref.scriptPath })
    const spec = await loadWorkflowScriptSpec(childScriptPath, subArgs, { childWorkflowDepth: 1, cwd })
    return { plan: validateWorkflowSpec(spec), script: spec.runScriptSnapshot }
  }

  function childResultText(result: unknown): string {
    if (typeof result === 'string') return result
    const serialized = JSON.stringify(result)
    return serialized ?? String(result)
  }

  function childPlanPrompt(
    phase: WorkflowDryRunPhase,
    index: number,
    resultsByPhase: Map<string, Array<{ label: string; output: unknown }>>,
  ): string {
    const parts = [phase.agentPrompts?.[index] ?? phase.prompt]
    if (phase.dependsOn.length > 0) {
      const lines = ['Upstream phase outputs:']
      for (const dependencyId of phase.dependsOn) {
        lines.push(`## ${dependencyId}`)
        for (const result of resultsByPhase.get(dependencyId) ?? []) {
          lines.push(`- ${result.label}: ${childResultText(result.output)}`)
        }
      }
      parts.push(lines.join('\n'))
    }
    return parts.join('\n\n')
  }

  async function runChildPlan(plan: WorkflowDryRunPlan): Promise<unknown[]> {
    const results: unknown[] = []
    const resultsByPhase = new Map<string, Array<{ label: string; output: unknown }>>()
    for (const phase of workflowPhaseExecutionOrder(plan.phases)) {
      const phaseResults: Array<{ label: string; output: unknown }> = []
      for (let index = 0; index < phase.fanout; index += phase.concurrency) {
        const batchIndexes = Array.from(
          { length: Math.min(phase.concurrency, phase.fanout - index) },
          (_, offset) => index + offset,
        )
        const batchResults = await Promise.all(batchIndexes.map(async batchIndex => {
          const label = phase.agentLabels?.[batchIndex] ?? `${phase.id}-${batchIndex + 1}`
          const output = await realAgent(childPlanPrompt(phase, batchIndex, resultsByPhase), {
            label,
            phase: phase.id,
            agentType: phase.agentType,
            model: phase.model,
            mode: phase.permissionMode,
          })
          return { label, output }
        }))
        phaseResults.push(...batchResults)
        results.push(...batchResults.map(result => result.output))
      }
      resultsByPhase.set(phase.id, phaseResults)
    }
    return results
  }

  async function runChildOfficialScript(script: string, subArgs?: WorkflowArgs): Promise<unknown> {
    const parsed = parseWorkflowScript(script)
    const childSandbox = vm.createContext(
      Object.create(null),
      { codeGeneration: { strings: false, wasm: false } },
    )
    defineSandboxGlobal(childSandbox, 'args', subArgs === undefined ? undefined : JSON.parse(JSON.stringify(subArgs)))
    defineSandboxGlobal(childSandbox, 'agent', realAgent)
    defineSandboxGlobal(childSandbox, 'pipeline', realPipeline)
    defineSandboxGlobal(childSandbox, 'parallel', realParallel)
    defineSandboxGlobal(childSandbox, 'workflow', () => Promise.reject(childWorkflowNestingError()))
    defineSandboxGlobal(childSandbox, 'phase', (title: string) => {
      currentPhaseId = title
      emit(createWorkflowPhaseEvent({ workflowRunId, phaseId: title, status: 'running' }))
    })
    defineSandboxGlobal(childSandbox, 'log', (message: string) => {
      if (logs.length < MAX_LOGS) logs.push(String(message))
      emit(createWorkflowLogEvent({ workflowRunId, message: String(message) }))
    })
    defineSandboxGlobal(childSandbox, 'budget', Object.freeze({ get total() { return budget.total }, spent: budget.spent, remaining: budget.remaining }))
    defineSandboxGlobal(childSandbox, 'Date', Object.assign(
      () => { throw new Error('Date() unavailable in workflow scripts (breaks resume)') },
      { now: () => { throw new Error('Date.now() unavailable') }, parse: Date.parse, UTC: Date.UTC },
    ))
    defineSandboxGlobal(childSandbox, 'Math', (() => {
      const m = Object.create(Math)
      Object.defineProperty(m, 'random', { value: () => { throw new Error('Math.random() unavailable (breaks resume)') } })
      return Object.freeze(m)
    })())
    defineSandboxGlobal(childSandbox, 'URL', URL)
    defineSandboxGlobal(childSandbox, 'eval', () => { throw new Error('eval() unavailable in workflow scripts (breaks resume)') })
    defineSandboxGlobal(childSandbox, 'Function', () => { throw new Error('Function() unavailable in workflow scripts (breaks resume)') })
    defineSandboxGlobal(childSandbox, 'console', { log: (msg: unknown) => { if (logs.length < MAX_LOGS) logs.push(String(msg)) } })
    return await new vm.Script(`(async (eval, Function) => {\n${parsed.scriptBody}\n})(eval, Function)`, {
      filename: 'child-workflow-script.js',
    }).runInContext(childSandbox, { timeout: SYNC_TIMEOUT_MS })
  }

  // --- workflow() sub-call ---
  async function realWorkflow(nameOrRef: string | { scriptPath: string }, subArgs?: WorkflowArgs): Promise<unknown> {
    const parentPhaseId = currentPhaseId
    try {
      const childArgs = subArgs ?? args
      const child = await loadChildWorkflow(nameOrRef, childArgs)
      if (child.script && hasWorkflowScriptMeta(child.script)) {
        const parsedChild = parseWorkflowScript(child.script)
        childWorkflowProgressName = parsedChild.meta.name
        try {
          return await runChildOfficialScript(child.script, childArgs)
        } finally {
          childWorkflowProgressName = undefined
        }
      }
      const results = await runChildPlan(child.plan)
      return {
        label: child.plan.name,
        output: results.map(childResultText).join('\n'),
      }
    } finally {
      currentPhaseId = parentPhaseId
    }
  }

  const launchEnvelope = workflowLaunchEnvelope({
    taskId: workflowTask.id,
    summary: plan.description,
    transcriptDir,
    scriptPath,
    workflowRunId,
  })

  // --- Execute ---
  const workflowRun = (async () => {
    try {
      await emit(createWorkflowProgressEvent({ workflowRunId, status: 'running', completedAgents: 0, totalAgents: agentCount }))
    await emit(createWorkflowLogEvent({ workflowRunId, message: `Workflow script started: ${plan.name}` }))

    const parsed = parseWorkflowScript(script)
    const sandbox = vm.createContext(
      Object.create(null),
      { codeGeneration: { strings: false, wasm: false } },
    )
    defineSandboxGlobal(sandbox, 'args', args === undefined ? undefined : JSON.parse(JSON.stringify(args)))
    defineSandboxGlobal(sandbox, 'agent', realAgent)
    defineSandboxGlobal(sandbox, 'pipeline', realPipeline)
    defineSandboxGlobal(sandbox, 'parallel', realParallel)
    defineSandboxGlobal(sandbox, 'workflow', realWorkflow)
    defineSandboxGlobal(sandbox, 'phase', (title: string) => {
      currentPhaseId = title
      emit(createWorkflowPhaseEvent({ workflowRunId, phaseId: title, status: 'running' }))
    })
    defineSandboxGlobal(sandbox, 'log', (message: string) => {
      if (logs.length < MAX_LOGS) logs.push(String(message))
      emit(createWorkflowLogEvent({ workflowRunId, message: String(message) }))
    })
    defineSandboxGlobal(sandbox, 'budget', Object.freeze({ get total() { return budget.total }, spent: budget.spent, remaining: budget.remaining }))
    defineSandboxGlobal(sandbox, 'Date', Object.assign(
      () => { throw new Error('Date() unavailable in workflow scripts (breaks resume)') },
      { now: () => { throw new Error('Date.now() unavailable') }, parse: Date.parse, UTC: Date.UTC },
    ))
    defineSandboxGlobal(sandbox, 'Math', (() => {
      const m = Object.create(Math)
      Object.defineProperty(m, 'random', { value: () => { throw new Error('Math.random() unavailable (breaks resume)') } })
      return Object.freeze(m)
    })())
    defineSandboxGlobal(sandbox, 'URL', URL)
    defineSandboxGlobal(sandbox, 'console', { log: (msg: unknown) => { if (logs.length < MAX_LOGS) logs.push(String(msg)) } })

    const scriptCode = new vm.Script(
      `(async () => {\n${parsed.scriptBody}\n})()`,
      { filename: scriptPath || 'workflow-script.js' },
    )
    const resultPromise = scriptCode.runInContext(sandbox, { timeout: SYNC_TIMEOUT_MS })

    const scriptResult = await Promise.race([
      resultPromise,
      new Promise((_, reject) => {
        if (abortController.signal.aborted) reject(new Error('Workflow aborted'))
        else abortController.signal.addEventListener('abort', () => reject(new Error('Workflow aborted')))
      }),
    ])
    if (typeof scriptResult === 'function') {
      throw new Error('workflow result cannot be a function')
    }

    const resultText = serializeWorkflowScriptResult(
      scriptResult,
      `Workflow completed. ${agentCount} agents, ${tokenSpent} tokens.`,
    )

    completeWorkflowTask(workflowTask.id, setAppState)
    await emit(createWorkflowProgressEvent({ workflowRunId, status: 'completed', completedAgents: agentCount, totalAgents: agentCount }))
    await completeWorkflowRunSession({ cwd, session: runSession, results: scriptAgentResults, resumeCacheEntries: journal.entries() })

    const outputFile = await writeWorkflowResult(workflowTask.id, resultText)
    const summary = `Dynamic workflow "${plan.description}" completed`
    enqueueWorkflowNotification({
      taskId: workflowTask.id,
      toolUseId: context.toolUseId,
      status: 'completed',
      summary,
      outputFile,
      resultText,
    })
    emitTaskTerminatedSdk(workflowTask.id, 'completed', {
      toolUseId: context.toolUseId,
      summary,
      outputFile,
      usage: {
        total_tokens: tokenSpent,
        tool_uses: toolUseSpent,
        duration_ms: Date.now() - workflowTask.startTime,
      },
    })

    } catch (error) {
    const abortStatus = workflowAbortStatus(abortController.signal.reason)
    if (abortStatus) {
      await updateWorkflowRunSessionProgress({
        cwd,
        session: runSession,
        results: scriptAgentResults,
        resumeCacheEntries: journal.entries(),
      })
      const resumeCall = workflowResumeCall({ ...workflowTask, scriptPath, workflowRunId })
      await updateWorkflowRunSessionStatus({
        cwd,
        workflowRunId,
        status: abortStatus,
        ...(abortStatus === 'paused' && resumeCall
          ? { resumePrompt: resumeCall }
          : {}),
      })
      if (abortStatus === 'killed') {
        emitTaskTerminatedSdk(workflowTask.id, 'stopped', {
          toolUseId: context.toolUseId,
          summary: `Dynamic workflow "${plan.description}" stopped`,
          usage: {
            total_tokens: tokenSpent,
            tool_uses: toolUseSpent,
            duration_ms: Date.now() - workflowTask.startTime,
          },
        })
      }
      return
    }

    abortController.abort()
    const message = workflowErrorMessage(error, 'Workflow script failed without error details')
    failWorkflowTask(workflowTask.id, message, setAppState)
    await emit(createWorkflowProgressEvent({ workflowRunId, status: 'failed', completedAgents: agentCount, totalAgents: agentCount }))
    await failWorkflowRunSession({ cwd, session: runSession, results: scriptAgentResults, error: message, resumeCacheEntries: journal.entries() })
    const outputFile = await writeWorkflowResult(workflowTask.id, message)
    const summary = `Dynamic workflow "${plan.description}" failed: ${message}`
    enqueueWorkflowNotification({
      taskId: workflowTask.id,
      toolUseId: context.toolUseId,
      status: 'failed',
      summary,
      outputFile,
      resultText: message,
    })
    emitTaskTerminatedSdk(workflowTask.id, 'failed', {
      toolUseId: context.toolUseId,
      summary,
      outputFile,
      usage: {
        total_tokens: tokenSpent,
        tool_uses: toolUseSpent,
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
