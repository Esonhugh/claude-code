import vm from 'node:vm'
import { availableParallelism } from 'node:os'
import { dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { AssistantMessage } from '../../types/message.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { generateTaskId } from '../../Task.js'
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
  classifyWorkflowAgentError,
  completeWorkflowAgent,
  completeWorkflowTask,
  failWorkflowAgent,
  failWorkflowTask,
  interruptWorkflowAgentAttempt,
  recordWorkflowAgentController,
  recordWorkflowAgentProgress,
  recordWorkflowAgentStarted,
  recordWorkflowEvent,
  registerWorkflowTask,
  shouldAutomaticallyRetryWorkflowAgent,
  startWorkflowPhase,
  workflowResumeCall,
  WORKFLOW_AGENT_SKIPPED_ABORT_REASON,
  WORKFLOW_AGENT_USER_RETRY_ABORT_REASON,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {
  LocalWorkflowTaskState,
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
  loadWorkflowRunSession,
  tryStartWorkflowRunSession,
  updateWorkflowRunSessionProgress,
  updateWorkflowRunSessionStatus,
} from './workflowRunSessions.js'
import { logForDebugging } from '../../utils/debug.js'
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
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import {
  appendWorkflowJournalFailed,
  appendWorkflowJournalLaunched,
  appendWorkflowJournalResult,
  appendWorkflowJournalStarted,
  readWorkflowJournalCacheEntries,
  readWorkflowJournalEntries,
} from './workflowJournal.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'
import { loadWorkflowScriptSpec } from './workflowDsl.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'
import { workflowPhaseExecutionOrder } from './workflowPhaseScheduler.js'
import { createSyntheticOutputTool } from '../SyntheticOutputTool/SyntheticOutputTool.js'
import { callWorkflowAgent, snapshotWorkflowAgentContext } from './runWorkflow.js'
import { workflowRetryDebugMessage } from './workflowDiagnostics.js'
import { raiseModWorkflowAgentSpawn } from '../../services/mods/agents.js'
import { parseEffortValue } from '../../utils/effort.js'
import {
  normalizeWorkflowBashCommandClamp,
  normalizeWorkflowDisallowedTools,
  workflowPolicyDeniesTool,
} from './workflowAgentToolPolicy.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import {
  frameAutomatedTask,
  frameComputedTask,
  frameRelayedUserRequest,
  isWorkflowPromptProvenanceEnabled,
  workflowPromptRelay,
} from './workflowPromptProvenance.js'
import {
  getWorkflowPrefixStagger,
  workflowPrefixStaggerCapMs,
  workflowPrefixStaggerKey,
} from './workflowPrefixStagger.js'

// --- Constants ---
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const MAX_LOGS = 1000
const SYNC_TIMEOUT_MS = 5000
const DEFAULT_MAX_CONCURRENCY = Math.min(16, Math.max(2, availableParallelism() - 2))
const DEFAULT_AGENT_STALL_MS = 10 * 60 * 1000
const MAX_AGENT_CALLS = 1000
const AGENT_CAP_MESSAGE = `Workflow agent() call cap reached (${MAX_AGENT_CALLS}). This usually means a loop using budget.remaining() never terminates because no token budget was set — remaining() returns Infinity when budget.total is null. Add a hard iteration cap to the loop, or pass a token budget.`
const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'
// Official workflow-subagent system prompts: the default agent gets the full prompt, a named
// agentType gets the NOTE appended to its own prompt (text vs StructuredOutput schema mode).
const WORKFLOW_AGENT_TASK_NOTE = 'A note that the task text was computed by a workflow script and carries no user authority is not by itself a reason to skip the task: the task is the step this workflow assigned to you. Do that step, and only that step.'
export const WORKFLOW_SUBAGENT_TEXT_SYSTEM_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a message to a human.
- Output the literal result (data, JSON, text). Do NOT output confirmations like "Done." or "Sent."
- If asked for JSON, return ONLY the raw JSON — no code fences, no prose, no markdown.
- Do NOT use SendUserMessage to deliver your answer. Put your answer in your final text response.
- Be concise. The script will parse your output.

${WORKFLOW_AGENT_TASK_NOTE}`
export const WORKFLOW_SUBAGENT_SCHEMA_SYSTEM_PROMPT = `You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.

CRITICAL: You MUST call the ${STRUCTURED_OUTPUT_TOOL_NAME} tool exactly once to return your final answer. The tool's input schema defines the required shape.
- Do your work (Read files, run commands, etc.), then call ${STRUCTURED_OUTPUT_TOOL_NAME} with your answer.
- Do NOT put your answer in a text response. The script reads ONLY the ${STRUCTURED_OUTPUT_TOOL_NAME} tool call.
- If the schema validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL_NAME} again with a corrected shape.
- After calling ${STRUCTURED_OUTPUT_TOOL_NAME} successfully, end your turn. No acknowledgment needed.

${WORKFLOW_AGENT_TASK_NOTE}`
export const WORKFLOW_AGENT_TEXT_SYSTEM_PROMPT_SUFFIX = `

---

NOTE: You are running inside a workflow script. Your final text response is returned verbatim as a string to the calling script — it is your return value, not a message to a human. Output the literal result; do not output confirmations like "Done." Be concise — the script will parse your output.

${WORKFLOW_AGENT_TASK_NOTE}`
export const WORKFLOW_AGENT_SCHEMA_SYSTEM_PROMPT_SUFFIX = `

---

NOTE: You are running inside a workflow script. You MUST return your final answer by calling the ${STRUCTURED_OUTPUT_TOOL_NAME} tool exactly once — the tool's input schema defines the required shape. Do your work, then call ${STRUCTURED_OUTPUT_TOOL_NAME}; do NOT put your answer in a text response (the script reads ONLY the tool call). If validation fails, read the error and call ${STRUCTURED_OUTPUT_TOOL_NAME} again with a corrected shape.

${WORKFLOW_AGENT_TASK_NOTE}`

export function workflowAgentSystemPrompt(opts: AgentOpts | undefined): ToolUseContext['workflowAgentSystemPrompt'] {
  if (opts?.agentType === undefined) {
    return { replace: opts?.schema ? WORKFLOW_SUBAGENT_SCHEMA_SYSTEM_PROMPT : WORKFLOW_SUBAGENT_TEXT_SYSTEM_PROMPT }
  }
  return { append: opts.schema ? WORKFLOW_AGENT_SCHEMA_SYSTEM_PROMPT_SUFFIX : WORKFLOW_AGENT_TEXT_SYSTEM_PROMPT_SUFFIX }
}

function workflowRetryBudget(maxRetries: number | undefined): number {
  return maxRetries ?? 2
}

function workflowMaxConcurrency(): number {
  const raw = process.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS
  const parsed = raw === undefined ? NaN : Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_MAX_CONCURRENCY
  logForDebugging(`workflow: concurrent agent gate = ${parsed} (CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS)`)
  return parsed
}

function defaultWorkflowAgentStallMs(): number {
  const parsed = Number(process.env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_STALL_MS
}

// --- Types ---
type AgentToolInput = {
  run_in_background: false
  description: string
  prompt: string
  subagent_type?: string
  model?: 'sonnet' | 'opus' | 'haiku'
  mode?: WorkflowPermissionMode
  isolation?: 'worktree'
  effort?: string | number
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
  effort?: string | number
  disallowedTools?: string[]
  bashCommandClamp?: string[]
}

// Official 2.1.303 validates and normalizes these opts before the agent is keyed,
// so malformed input refuses the spawn instead of running an un-narrowed agent.
function normalizeAgentOpts(opts: AgentOpts | undefined): AgentOpts | undefined {
  if (!opts) return opts
  const normalized: AgentOpts = { ...opts }
  if (opts.effort !== undefined) {
    const effort = parseEffortValue(opts.effort)
    if (effort === undefined) {
      throw new Error(`agent() opts.effort must be one of low, medium, high, xhigh, max or a number 1-100; got ${JSON.stringify(opts.effort)}.`)
    }
    normalized.effort = effort
  }
  const disallowedTools = normalizeWorkflowDisallowedTools(opts.disallowedTools)
  const bashCommandClamp = normalizeWorkflowBashCommandClamp(opts.bashCommandClamp)
  if (disallowedTools === undefined) delete normalized.disallowedTools
  else normalized.disallowedTools = disallowedTools
  if (bashCommandClamp === undefined) delete normalized.bashCommandClamp
  else normalized.bashCommandClamp = bashCommandClamp
  const policy = { disallowedTools, bashCommandClamp }
  if (bashCommandClamp && workflowPolicyDeniesTool(policy, BASH_TOOL_NAME)) {
    throw new Error(`agent() opts.bashCommandClamp cannot be combined with disallowedTools that remove ${BASH_TOOL_NAME}: the clamp would bind nothing. Drop the clamp or the Bash deny.`)
  }
  if (opts.schema && workflowPolicyDeniesTool(policy, STRUCTURED_OUTPUT_TOOL_NAME)) {
    throw new Error(`agent() opts.schema requires the ${STRUCTURED_OUTPUT_TOOL_NAME} tool, but opts.disallowedTools removes it. Drop the schema or the deny.`)
  }
  return normalized
}

type WorkflowAgentAttemptUsage = Pick<
  WorkflowAgentResult,
  'tokenCount' | 'toolUseCount' | 'durationMs'
>

class WorkflowAgentAttemptError extends Error {
  constructor(
    message: string,
    readonly usage: WorkflowAgentAttemptUsage,
  ) {
    super(message)
    this.name = 'WorkflowAgentAttemptError'
  }
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
// Like official 2.1.292, the longest unchanged prefix of agent() calls replays from the
// journal: after the first call without a cached result, every later call runs live,
// except that an agent the previous run started but never finished respawns alone.
class WorkflowJournal {
  private entriesByIdentity = new Map<string, WorkflowResumeCacheEntry[]>()
  private recordedEntries: WorkflowResumeCacheEntry[] = []
  private interruptedIdentities = new Set<string>()
  private live = false
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
    const entry = this.live ? undefined : this.entriesByIdentity.get(identity)?.shift()
    if (entry) return { hit: true, result: entry.result }
    if (!this.interruptedIdentities.has(identity)) this.live = true
    return { hit: false }
  }
  entries(): WorkflowResumeCacheEntry[] {
    return this.recordedEntries
  }
  loadFrom(entries: WorkflowResumeCacheEntry[], interruptedIdentities: Iterable<string> = []): void {
    this.interruptedIdentities = new Set(interruptedIdentities)
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

async function enqueueWorkflowNotification({
  taskId,
  toolUseId,
  status,
  summary,
  outputFile,
  resultText,
  failures = [],
  usage,
  setAppState,
}: {
  taskId: string
  toolUseId?: string
  status: 'completed' | 'failed' | 'killed'
  summary: string
  outputFile: string
  resultText: string
  failures?: string[]
  usage: { total_tokens: number; tool_uses: number; duration_ms: number }
  setAppState: ToolUseContext['setAppState']
}): Promise<void> {
  let shouldEnqueue = false
  setAppState(prev => {
    const task = prev.tasks[taskId]
    shouldEnqueue = task?.type === 'local_workflow' && !task.notified
    return prev
  })
  if (!shouldEnqueue) return
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
<result>${truncatedResult}</result>${failures.length > 0 ? `\n<failures>${escapeXmlText(failures.join('\n'))}</failures>` : ''}
<usage><total_tokens>${usage.total_tokens}</total_tokens><tool_uses>${usage.tool_uses}</tool_uses><duration_ms>${usage.duration_ms}</duration_ms></usage>
</${TASK_NOTIFICATION_TAG}>`
  await enqueuePendingNotification({ value: message, mode: 'task-notification' })
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (task?.type !== 'local_workflow' || task.notified) return prev
    return { ...prev, tasks: { ...prev.tasks, [taskId]: { ...task, notified: true } } }
  })
}

function workflowAbortStatus(reason: unknown): 'paused' | 'killed' | undefined {
  if (reason === 'workflow-paused') return 'paused'
  if (reason === 'workflow-killed') return 'killed'
  return undefined
}

export type WorkflowScriptResume = {
  entries: WorkflowResumeCacheEntry[]
  interruptedIdentities: Set<string>
}

// Like official 2.1.292: a run that is still running cannot be resumed (two copies would
// share one journal), and a run without a journal has nothing to resume.
export async function loadWorkflowScriptResume({
  cwd,
  workflowRunId,
  context,
}: {
  cwd: string
  workflowRunId: string
  context: ToolUseContext
}): Promise<WorkflowScriptResume> {
  for (const [taskId, task] of Object.entries(context.getAppState().tasks)) {
    if (task.type === 'local_workflow' && task.workflowRunId === workflowRunId && task.status === 'running') {
      throw new Error(`Workflow ${workflowRunId} is still running (task ${taskId}). Stop it first with ${TASK_STOP_TOOL_NAME}({taskId: "${taskId}"}) before resuming.`)
    }
  }
  const session = await loadWorkflowRunSession({ cwd, workflowRunId })
  const journal = session ? await readWorkflowJournalEntries(session.transcriptDir) : []
  // A legacy DSL run has no journal; its record carries the cache entries instead.
  if (!session || (journal.length === 0 && session.resumeCacheEntries.length === 0)) {
    throw new Error(`No journal found for workflow run ${workflowRunId}, so there is nothing to resume. To run the workflow from the start, call Workflow again without resumeFromRunId.`)
  }
  // A skipped or user-interrupted attempt (this build's statuses) respawns like an unfinished one.
  const finished = new Set(journal.flatMap(entry =>
    entry.type === 'result' || (entry.type === 'failed' && (entry.status ?? 'failed') === 'failed') ? [entry.key] : []))
  return {
    entries: journal.length > 0
      ? await readWorkflowJournalCacheEntries(session.transcriptDir)
      : session.resumeCacheEntries,
    interruptedIdentities: new Set(journal.flatMap(entry => entry.type === 'started' && !finished.has(entry.key) ? [entry.key] : [])),
  }
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
  resumeInterruptedIdentities,
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
  resumeInterruptedIdentities?: Iterable<string>
}): Promise<string> {
  const agentTool = findAgentTool(context.options.tools)
  if (!agentTool) throw new Error('Workflow script execution requires the Agent tool')

  const setAppState = context.setAppStateForTasks ?? context.setAppState
  const cwd = 'getCwd' in context && typeof context.getCwd === 'function'
    ? context.getCwd() : getCwd()
  const taskId = generateTaskId('local_workflow')
  const startedRun = await tryStartWorkflowRunSession({
    cwd,
    taskId,
    plan,
    runArgs: args,
    workflowRunId,
    scriptPath,
    resumeFromRunId,
  })
  let runSession = startedRun.session
  if (!startedRun.started) {
    return `Workflow run ${workflowRunId} is already ${runSession.status}. Task ID: ${runSession.taskId}`
  }
  const transcriptDir = runSession.transcriptDir
  await appendWorkflowJournalLaunched(transcriptDir)

  let workflowTask: ReturnType<typeof registerWorkflowTask>
  try {
    workflowTask = registerWorkflowTask({
      plan,
      setAppState,
      toolUseId: context.toolUseId,
      runArgs: args,
      workflowRunId,
      scriptPath,
      defaultModel: context.options.mainLoopModel,
      dynamicAgentCount: true,
      taskId,
    })
  } catch (error) {
    await failWorkflowRunSession({
      cwd,
      session: runSession,
      results: [],
      error: workflowErrorMessage(
        error,
        'Workflow task registration failed without error details',
      ),
    })
    throw error
  }

  const logs: string[] = []
  let agentCount = 0
  let tokenSpent = 0
  let toolUseSpent = 0
  let currentPhaseId = plan.phases[0]?.id ?? plan.name
  let childWorkflowProgressName: string | undefined
  const abortController = workflowTask.abortController!
  const maxConcurrency = workflowMaxConcurrency()
  const semaphore = new Semaphore(maxConcurrency)
  const journal = new WorkflowJournal()
  if (resumeJournalEntries) {
    journal.loadFrom(resumeJournalEntries, resumeInterruptedIdentities)
    logForDebugging(
      workflowRetryDebugMessage({
        event: 'workflow_session_loaded',
        taskId: workflowTask.id,
        workflowRunId,
        phaseId: '-',
        logicalAgentId: '-',
        agentId: '-',
        attempt: 0,
        detail: `resume_entries=${resumeJournalEntries.length}`,
      }),
    )
  }
  const scriptAgentResults: WorkflowAgentResult[] = []
  const pendingRuntimeCalls = new Set<Promise<unknown>>()
  // Like official, agent failures are reported to the caller and the run still completes;
  // only an error thrown by the script itself fails the run.
  const failures: string[] = []
  let runtimeCallGeneration = 0
  const countedFailedAttemptIds = new Set<string>()
  const agentLabelOccurrences = new Map<string, number>()
  const assignedAgentIds = new Set<string>()
  const phaseAgentCounts = new Map<string, number>()
  // Like official, every agent() call chains its key on the previous call's, in call order.
  let workflowAgentIdentitySeed = ''
  const currentWorkflowProgress = () => {
    const task = context.getAppState().tasks[workflowTask.id]
    return workflowProgressSnapshot(
      plan,
      task?.type === 'local_workflow' ? task : undefined,
    )
  }
  const logWorkflowPhaseTerminals = (fallbackStatus: string) => {
    const task = context.getAppState().tasks[workflowTask.id]
    const phases = task?.type === 'local_workflow' ? task.phases : []
    for (const phase of phases) {
      logForDebugging(
        workflowRetryDebugMessage({
          event: 'workflow_phase_terminal',
          taskId: workflowTask.id,
          workflowRunId,
          phaseId: phase.id,
          logicalAgentId: '-',
          agentId: '-',
          attempt: 0,
          status: phase.status || fallbackStatus,
        }),
      )
    }
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
  function currentWorkflowTaskUsage(): { tokenCount: number; toolUseCount: number } {
    const task = context.getAppState().tasks[workflowTask.id]
    if (task?.type !== 'local_workflow') {
      return { tokenCount: tokenSpent, toolUseCount: toolUseSpent }
    }
    return {
      tokenCount: task.tokenCount ?? 0,
      toolUseCount: task.toolUseCount ?? 0,
    }
  }
  function syncRuntimeUsageFromWorkflowTask() {
    const usage = currentWorkflowTaskUsage()
    tokenSpent = Math.max(tokenSpent, usage.tokenCount)
    toolUseSpent = Math.max(toolUseSpent, usage.toolUseCount)
  }
  function countFailedAttemptUsage(attemptId: string, result: WorkflowAgentResult | undefined) {
    if (!result || countedFailedAttemptIds.has(attemptId)) return
    tokenSpent += result.tokenCount ?? 0
    toolUseSpent += result.toolUseCount ?? 0
    countedFailedAttemptIds.add(attemptId)
  }
  function checkBudget() {
    if (budget.total !== null && tokenSpent >= budget.total) {
      throw new Error('WorkflowBudgetExceededError: token budget exhausted')
    }
  }
  // Like official, branches dropped for the budget are counted once per call.
  function isBudgetError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith('WorkflowBudgetExceededError')
  }
  function recordBudgetDrops(call: 'parallel' | 'pipeline', dropped: number) {
    if (dropped > 0) failures.push(`${call}: ${dropped} ${dropped === 1 ? 'slot' : 'slots'} dropped — token budget exceeded`)
  }
  function trackRuntimeCall<T>(call: Promise<T>): Promise<T> {
    runtimeCallGeneration++
    pendingRuntimeCalls.add(call)
    void call.then(
      () => pendingRuntimeCalls.delete(call),
      () => pendingRuntimeCalls.delete(call),
    )
    return call
  }

  // --- Real agent() with stall detection, retry, schema, worktree ---
  function realAgent(
    prompt: string,
    opts?: AgentOpts,
  ): Promise<unknown> {
    return trackRuntimeCall(runAgent(prompt, opts))
  }

  async function runAgent(
    prompt: string,
    rawOpts?: AgentOpts,
  ): Promise<unknown> {
    if (abortController.signal.aborted) return null
    checkBudget()
    if (agentCount >= MAX_AGENT_CALLS) throw new Error(AGENT_CAP_MESSAGE)
    let opts = normalizeAgentOpts(rawOpts)

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
    const identityKey = createWorkflowScriptAgentChainIdentity({
      previousKey: workflowAgentIdentitySeed,
      prompt,
      opts,
    })
    workflowAgentIdentitySeed = identityKey
    agentCount++
    // Look up before any await so the journal sees calls in launch order.
    const cached = journal.lookup(identityKey)

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
        logicalAgentId,
        attemptId: `${phase}:${logicalAgentId}:attempt:0`,
        attempt: 0,
        tokenCount: 0,
        toolUseCount: 0,
        durationMs: 0,
        result: cached.result,
        timestamp: Date.now(),
      })
      await emit(createWorkflowAgentEvent({ workflowRunId, phaseId: phase, agentId: agentId, status: 'completed', cacheHit: true }))
      return cached.result
    }

    // Journal hits above are replayed, not raised; a deny is this agent() call's error.
    const spawned = await raiseModWorkflowAgentSpawn(context, {
      prompt,
      model: opts?.model,
      agentId,
      runId: workflowRunId ?? '',
      agentIndex: agentCount,
      description: agentId,
      subagentType: opts?.agentType ?? 'general-purpose',
    })
    prompt = spawned.prompt
    if (spawned.model !== opts?.model) opts = { ...opts, model: spawned.model }

    const stallMs = opts?.stallMs ?? defaultWorkflowAgentStallMs()

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
      logForDebugging(
        workflowRetryDebugMessage({
          event: 'workflow_worker_start',
          taskId: workflowTask.id,
          workflowRunId,
          phaseId: phase,
          logicalAgentId,
          agentId: attemptAgentId,
          attempt,
          workerIndex: phaseAgentIndex,
        }),
      )
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
          ...(completedResult?.tokenCount !== undefined
            ? { tokenCount: completedResult.tokenCount }
            : {}),
          ...(completedResult?.toolUseCount !== undefined
            ? { toolUseCount: completedResult.toolUseCount }
            : {}),
          ...(completedResult?.durationMs !== undefined
            ? { durationMs: completedResult.durationMs }
            : {}),
          result,
          timestamp: completedAt,
        })
        return result
      } catch (error) {
        if (abortController.signal.aborted) return null
        const msg = workflowErrorMessage(error, `Workflow agent failed without error details: ${attemptAgentId}`)
        if (msg === WORKFLOW_AGENT_SKIPPED_ABORT_REASON) {
          const skippedTask = context.getAppState().tasks[workflowTask.id]
          const skippedPhase = skippedTask?.type === 'local_workflow'
            ? skippedTask.phases.find(current => current.id === phase)
            : undefined
          const skippedAgentAliases = new Set(
            [
              attemptAgentId,
              logicalAgentId,
              agentId,
              skippedPhase?.agentIds[phaseAgentIndex],
            ].filter((currentAgentId): currentAgentId is string => Boolean(currentAgentId)),
          )
          const stateSkippedResult = skippedTask?.type === 'local_workflow'
            ? [
                ...skippedTask.results,
                ...(skippedPhase?.results ?? []),
              ].find(current =>
                current.phaseId === phase &&
                current.index === phaseAgentIndex &&
                current.status === 'skipped' &&
                skippedAgentAliases.has(current.agentId),
              )
            : undefined
          const scriptSkippedResult: WorkflowAgentResult = stateSkippedResult ?? {
            phaseId: phase,
            agentId: attemptAgentId,
            index: phaseAgentIndex,
            status: 'skipped',
            prompt,
          }
          scriptAgentResults.push(scriptSkippedResult)
          syncRuntimeUsageFromWorkflowTask()
          await appendWorkflowJournalFailed(transcriptDir, {
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
            ...(scriptSkippedResult.tokenCount !== undefined ? { tokenCount: scriptSkippedResult.tokenCount } : {}),
            ...(scriptSkippedResult.toolUseCount !== undefined ? { toolUseCount: scriptSkippedResult.toolUseCount } : {}),
            ...(scriptSkippedResult.durationMs !== undefined
              ? { durationMs: scriptSkippedResult.durationMs }
              : error instanceof WorkflowAgentAttemptError
                ? { durationMs: error.usage.durationMs }
                : {}),
            timestamp: Date.now(),
          })
          return null
        }
        const userRetryRequested = msg === WORKFLOW_AGENT_USER_RETRY_ABORT_REASON
        const errorKind = classifyWorkflowAgentError(error)
        const retryable = shouldAutomaticallyRetryWorkflowAgent(errorKind)
        if (!userRetryRequested) {
          logForDebugging(
            workflowRetryDebugMessage({
              event: 'workflow_worker_fail',
              taskId: workflowTask.id,
              workflowRunId,
              phaseId: phase,
              logicalAgentId,
              agentId: attemptAgentId,
              attempt,
              workerIndex: phaseAgentIndex,
              errorKind,
              retryable,
            }),
          )
        }
        const retryBudget = workflowRetryBudget(plan.defaults.maxRetries)
        const automaticRetryRequested = retryable && automaticRetries < retryBudget
        if (userRetryRequested || automaticRetryRequested) {
          let userRetryAttemptUsage: WorkflowAgentAttemptUsage | undefined
          if (automaticRetryRequested) {
            failWorkflowAgent({
              taskId: workflowTask.id,
              phaseId: phase,
              agentId: attemptAgentId,
              index: phaseAgentIndex,
              error: msg,
              errorKind,
              setAppState,
              attemptId,
              prompt,
            })
          } else {
            interruptWorkflowAgentAttempt({
              taskId: workflowTask.id,
              agentId: attemptAgentId,
              error: msg,
              setAppState,
            })
            syncRuntimeUsageFromWorkflowTask()
            userRetryAttemptUsage = error instanceof WorkflowAgentAttemptError
              ? error.usage
              : undefined
          }
          const retryFailedTask = context.getAppState().tasks[workflowTask.id]
          const retryFailedResult = automaticRetryRequested && retryFailedTask?.type === 'local_workflow'
            ? retryFailedTask.results.find(
                current =>
                  current.phaseId === phase &&
                  current.index === phaseAgentIndex &&
                  current.agentId === attemptAgentId &&
                  current.status === 'failed',
              )
            : undefined
          const journalAttemptUsage = automaticRetryRequested
            ? {
                ...retryFailedResult,
                ...(error instanceof WorkflowAgentAttemptError
                  ? { durationMs: error.usage.durationMs }
                  : {}),
              }
            : userRetryAttemptUsage
          if (automaticRetryRequested) countFailedAttemptUsage(attemptId, retryFailedResult)
          await appendWorkflowJournalFailed(transcriptDir, {
            key: identityKey,
            agentId: attemptAgentId,
            logicalAgentId,
            attemptId,
            attempt,
            retryOfAttemptId,
            phase,
            label: agentId,
            index: phaseAgentIndex,
            status: automaticRetryRequested ? 'failed' : 'interrupted',
            error: msg,
            ...(automaticRetryRequested ? { errorKind } : {}),
            ...(journalAttemptUsage?.tokenCount !== undefined ? { tokenCount: journalAttemptUsage.tokenCount } : {}),
            ...(journalAttemptUsage?.toolUseCount !== undefined ? { toolUseCount: journalAttemptUsage.toolUseCount } : {}),
            ...(journalAttemptUsage?.durationMs !== undefined ? { durationMs: journalAttemptUsage.durationMs } : {}),
            timestamp: Date.now(),
          })
          logForDebugging(
            workflowRetryDebugMessage({
              event: automaticRetryRequested ? 'workflow_worker_retry_scheduled' : 'workflow_worker_user_retry',
              taskId: workflowTask.id,
              workflowRunId,
              phaseId: phase,
              logicalAgentId,
              agentId: attemptAgentId,
              attempt,
              workerIndex: phaseAgentIndex,
              ...(automaticRetryRequested
                ? { errorKind, retryable: true }
                : {}),
              detail: automaticRetryRequested
                ? `retry=${automaticRetries + 1}/${retryBudget}`
                : undefined,
            }),
          )
          if (automaticRetryRequested) automaticRetries++
          attempt++
          logs.push(`[retry] agent "${agentId}" retry ${attempt}${automaticRetryRequested ? `/${retryBudget}` : ''}`)
          continue
        }
        logForDebugging(
          workflowRetryDebugMessage({
            event: 'workflow_worker_terminal',
            taskId: workflowTask.id,
            workflowRunId,
            phaseId: phase,
            logicalAgentId,
            agentId: attemptAgentId,
            attempt,
            workerIndex: phaseAgentIndex,
            errorKind,
            retryable: shouldAutomaticallyRetryWorkflowAgent(errorKind),
            status: 'failed',
          }),
        )
        failWorkflowAgent({
          taskId: workflowTask.id, phaseId: phase, agentId: attemptAgentId,
          index: phaseAgentIndex, error: msg, errorKind, setAppState,
          attemptId, prompt,
        })
        const failedTask = context.getAppState().tasks[workflowTask.id]
        const failedResult = failedTask?.type === 'local_workflow'
          ? failedTask.results.find(
              current =>
                current.phaseId === phase &&
                current.index === phaseAgentIndex &&
                current.agentId === attemptAgentId &&
                current.status === 'failed',
            )
          : undefined
        const scriptFailedResult: WorkflowAgentResult = failedResult ?? {
          phaseId: phase,
          agentId: attemptAgentId,
          index: phaseAgentIndex,
          status: 'failed',
          error: msg,
          errorKind,
          prompt,
        }
        countFailedAttemptUsage(attemptId, scriptFailedResult)
        scriptAgentResults.push(scriptFailedResult)
        failures.push(`[${agentId}] failed: ${msg}`)
        await appendWorkflowJournalFailed(transcriptDir, {
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
          ...(scriptFailedResult.tokenCount !== undefined ? { tokenCount: scriptFailedResult.tokenCount } : {}),
          ...(scriptFailedResult.toolUseCount !== undefined ? { toolUseCount: scriptFailedResult.toolUseCount } : {}),
          ...(scriptFailedResult.durationMs !== undefined
            ? { durationMs: scriptFailedResult.durationMs }
            : error instanceof WorkflowAgentAttemptError
              ? { durationMs: error.usage.durationMs }
              : {}),
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
    phase: string, stallMs: number | undefined, phaseAgentIndex: number,
  ): Promise<unknown> {
    const agentAbortController = createChildAbortController(abortController)
    const attemptId = `${phase}:${logicalAgentId}:attempt:${attempt}`
    recordWorkflowAgentController({
      taskId: workflowTask.id, agentId,
      abortController: agentAbortController, setAppState,
      logicalAgentId, attempt, attemptId, index: phaseAgentIndex,
    })

    let lastProgress = Date.now()

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

    // Like official, the script-computed prompt is framed as such and the triggering user
    // request is relayed in its own turn; the journal and previews keep the raw prompt.
    const provenanceOn = isWorkflowPromptProvenanceEnabled()
    const relay = provenanceOn ? workflowPromptRelay(agentContext.messages, agentContext.agentId) : undefined
    const relayPrompt = relay?.kind === 'relay' ? frameRelayedUserRequest(relay) : undefined
    const framedPrompt = !provenanceOn
      ? prompt
      : relay?.kind === 'automated' ? frameAutomatedTask(prompt) : frameComputedTask(prompt)
    const input: AgentToolInput = {
      run_in_background: false,
      description,
      prompt: framedPrompt + schemaPrompt,
      subagent_type: opts?.agentType,
      model: opts?.model as AgentToolInput['model'],
      mode: permissionMode,
      ...(opts?.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
      ...(opts?.effort !== undefined ? { effort: opts.effort } : {}),
    }
    const workflowAgentToolPolicy = opts?.disallowedTools || opts?.bashCommandClamp
      ? { disallowedTools: opts.disallowedTools, bashCommandClamp: opts.bashCommandClamp }
      : undefined

    if (
      process.env.CLAUDE_CODE_WORKFLOW_FAULT_INJECTION_FOR_TESTING ===
      `service_unavailable:${logicalAgentId}:attempt:${attempt}`
    ) {
      throw new Error('503 service temporarily unavailable (controlled test fault)')
    }

    const stallTimer = stallMs !== undefined && Number.isFinite(stallMs) && stallMs > 0
      ? setInterval(() => {
          if (Date.now() - lastProgress > stallMs) {
            agentAbortController.abort('stalled')
          }
        }, Math.min(stallMs / 2, 30_000))
      : undefined
    let rejectOnAbort: ((reason?: unknown) => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = reject
    })
    const onAbort = () => {
      rejectOnAbort?.(
        new Error(
          workflowErrorMessage(
            agentAbortController.signal.reason,
            'Workflow agent aborted',
          ),
        ),
      )
    }
    agentAbortController.signal.addEventListener('abort', onAbort, { once: true })
    if (agentAbortController.signal.aborted) onAbort()

    const agentTools = structuredOutputTool
      ? [
          ...agentContext.options.tools.filter(
            tool => tool.name !== STRUCTURED_OUTPUT_TOOL_NAME,
          ),
          structuredOutputTool,
        ]
      : agentContext.options.tools
    // Like official, same-prefix siblings wait (at most capMs) for the leader's first
    // response so the shared prompt-cache prefix is warm before they land.
    const stagger = await getWorkflowPrefixStagger().enter(
      workflowPrefixStaggerKey({
        model: opts?.model ?? agentContext.options.mainLoopModel,
        effort: opts?.effort ?? context.getAppState().effortValue,
        agentType: opts?.agentType,
        toolNames: agentTools.map(tool => tool.name),
        schema: opts?.schema,
        cwd,
      }),
      { capMs: workflowPrefixStaggerCapMs(), signal: agentAbortController.signal },
    )
    if (stagger.waitedMs > 0) {
      logForDebugging(
        `workflow agent [${agentId}] held ${stagger.waitedMs}ms for a same-prefix sibling's first response (prompt-cache warm-up)`,
      )
    }

    const attemptStartedAt = Date.now()
    let progressTokens = 0
    let progressToolUses = 0
    try {
      const progressPhase = childWorkflowProgressName ?? phase
      const progressTracker = createProgressTracker()
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

      const agentCall = callWorkflowAgent(agentTool,
        input as never,
        {
          ...agentContext,
          abortController: agentAbortController,
          workflowAgentSystemPrompt: workflowAgentSystemPrompt(opts),
          workflowAgentToolPolicy,
          workflowAgentRelayPrompt: relayPrompt,
          // The subagent's first API response reaches the parent as its TTFT metrics entry,
          // which is the official "responded" point that releases staggered siblings.
          pushApiMetricsEntry: ttftMs => {
            stagger.responded()
            agentContext.pushApiMetricsEntry?.(ttftMs)
          },
          options: {
            ...agentContext.options,
            tools: agentTools,
            disableNestedAgentTools: true,
          },
        },
        canUseTool, assistantMessage,
        (progress) => {
          if (agentAbortController.signal.aborted) return
          const currentTask = context.getAppState().tasks[workflowTask.id]
          if (
            currentTask?.type !== 'local_workflow' ||
            currentTask.status !== 'running' ||
            currentTask.liveAgents?.[agentId] === undefined
          ) {
            return
          }
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
            if (!(data.message as { isApiErrorMessage?: boolean }).isApiErrorMessage) {
              stagger.responded()
            }
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
      const result = await Promise.race([agentCall, aborted])

      const output = result.data as AgentToolOutput
      if (agentAbortController.signal.reason === WORKFLOW_AGENT_USER_RETRY_ABORT_REASON) {
        throw new Error(WORKFLOW_AGENT_USER_RETRY_ABORT_REASON)
      }
      if (agentAbortController.signal.reason === WORKFLOW_AGENT_SKIPPED_ABORT_REASON) {
        throw new Error(WORKFLOW_AGENT_SKIPPED_ABORT_REASON)
      }
      const finalTokens = output.totalTokens ?? progressTokens
      const finalToolUses = output.totalToolUseCount ?? progressToolUses
      const finalTokenDelta = finalTokens - progressTokens
      const finalToolUseDelta = finalToolUses - progressToolUses
      if (finalTokenDelta !== 0 || finalToolUseDelta !== 0) {
        recordWorkflowAgentProgress({
          taskId: workflowTask.id, agentId,
          tokenCount: finalTokenDelta, toolUseCount: finalToolUseDelta,
          prompt: prompt.slice(0, 200),
          setAppState,
        })
        progressTokens = finalTokens
        progressToolUses = finalToolUses
      }
      if (output.status && output.status !== 'completed') {
        throw new Error(extractAgentText(output))
      }
      const text = extractAgentText(output)

      const agentResult = opts?.schema
        ? output.structured_output
        : text || null
      if (opts?.schema && agentResult === undefined) {
        throw new Error(`Workflow agent ${agentId} did not return structured output`)
      }

      tokenSpent += finalTokens
      toolUseSpent += finalToolUses

      completeWorkflowAgent({
        taskId: workflowTask.id,
        result: {
          phaseId: phase,
          agentId,
          index: phaseAgentIndex,
          status: 'completed',
          output: typeof agentResult === 'string'
            ? agentResult
            : JSON.stringify(agentResult),
          prompt,
          tokenCount: finalTokens,
          toolUseCount: finalToolUses,
          durationMs: output.totalDurationMs ?? 0,
        },
        setAppState,
        attemptId,
      })
      logForDebugging(
        workflowRetryDebugMessage({
          event: 'workflow_worker_terminal',
          taskId: workflowTask.id,
          workflowRunId,
          phaseId: phase,
          logicalAgentId,
          agentId,
          attempt,
          workerIndex: phaseAgentIndex,
          status: 'completed',
        }),
      )

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
      const attemptUsage = {
        tokenCount: progressTokens,
        toolUseCount: progressToolUses,
        durationMs: Date.now() - attemptStartedAt,
      }
      if (agentAbortController.signal.reason === 'stalled') {
        throw new WorkflowAgentAttemptError('stalled', attemptUsage)
      }
      if (agentAbortController.signal.reason === WORKFLOW_AGENT_USER_RETRY_ABORT_REASON) {
        throw new WorkflowAgentAttemptError(
          WORKFLOW_AGENT_USER_RETRY_ABORT_REASON,
          attemptUsage,
        )
      }
      if (agentAbortController.signal.reason === WORKFLOW_AGENT_SKIPPED_ABORT_REASON) {
        throw new WorkflowAgentAttemptError(
          WORKFLOW_AGENT_SKIPPED_ABORT_REASON,
          attemptUsage,
        )
      }
      if (error instanceof WorkflowAgentAttemptError) throw error
      throw new WorkflowAgentAttemptError(
        workflowErrorMessage(error, `Workflow agent failed without error details: ${agentId}`),
        attemptUsage,
      )
    } finally {
      stagger.done()
      if (stallTimer !== undefined) clearInterval(stallTimer)
      agentAbortController.signal.removeEventListener('abort', onAbort)
      rejectOnAbort = undefined
    }
  }

  // Official 2.1.303 caps arrays crossing the workflow VM boundary.
  const MAX_VM_ARRAY_LENGTH = 4096
  function assertVmArray(value: unknown, message: string): void {
    if (!Array.isArray(value)) throw new TypeError(message)
    if (value.length > MAX_VM_ARRAY_LENGTH) {
      throw new Error(`array length ${value.length} exceeds the maximum of ${MAX_VM_ARRAY_LENGTH} supported across the workflow VM boundary`)
    }
  }

  // --- parallel(): every item starts at once (the agent gate bounds the API fan-out), errors → null ---
  async function realParallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>> {
    assertVmArray(thunks, 'parallel() expects an array of functions')
    for (const thunk of thunks) {
      if (typeof thunk === 'function') continue
      // The script runs in its own vm realm, so detect promises by shape, not instanceof.
      throw new TypeError(
        typeof (thunk as { then?: unknown } | null)?.then === 'function'
          ? 'parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)'
          : 'parallel() expects an array of functions',
      )
    }
    if (abortController.signal.aborted) return thunks.map(() => null)
    checkBudget()
    let budgetDropped = 0
    const results = await Promise.all(Array.from(thunks, async (thunk, index) => {
      try {
        return await thunk()
      } catch (error) {
        if (isBudgetError(error)) {
          budgetDropped++
          return null
        }
        const msg = error instanceof Error ? error.message : String(error)
        logs.push(`parallel[${index}] failed: ${msg}`)
        failures.push(`parallel[${index}] failed: ${msg}`)
        return null
      }
    }))
    recordBudgetDrops('parallel', budgetDropped)
    return results
  }

  // --- pipeline(): no barrier between stages, per-item ---
  async function realPipeline<T>(items: T[], ...stages: Array<(val: any, orig: any, idx: number) => any>): Promise<any[]> {
    assertVmArray(items, 'pipeline() expects an array as the first argument')
    if (stages.some(stage => typeof stage !== 'function')) {
      throw new TypeError('pipeline() stages must be functions: pipeline(items, item => ..., result => ...)')
    }
    if (abortController.signal.aborted) return items.map(() => null)
    checkBudget()
    let budgetDropped = 0
    const results = await Promise.all(Array.from(items, async (item, index) => {
      let value: unknown = item
      for (const stage of stages) {
        if (value === null) break
        try { value = await stage(value, item, index) }
        catch (error) {
          if (isBudgetError(error)) budgetDropped++
          else failures.push(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`)
          value = null
        }
      }
      return value
    }))
    recordBudgetDrops('pipeline', budgetDropped)
    return results
  }

  function childWorkflowNestingError(): Error {
    return new Error('workflow() cannot be called from within a child workflow — nesting is limited to one level. Inline the inner script or call its agents directly.')
  }

  async function loadChildWorkflow(ref: string | { scriptPath: string }, subArgs?: WorkflowArgs): Promise<{ plan: WorkflowDryRunPlan; script?: string }> {
    if (typeof ref === 'string') {
      const workflow = await loadWorkflowSpecByNameOrPath(cwd, ref, subArgs)
      return { plan: workflow.plan, script: workflow.spec.runScriptSnapshot }
    }
    const childCwd = scriptPath ? dirname(scriptPath) : cwd
    const childScriptPath = await resolveWorkflowScriptPath({ cwd: childCwd, scriptPath: ref.scriptPath })
    const spec = await loadWorkflowScriptSpec(childScriptPath, subArgs)
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
    defineSandboxGlobal(
      childSandbox,
      'workflow',
      () => trackRuntimeCall(Promise.reject(childWorkflowNestingError())),
    )
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
  async function runChildWorkflow(nameOrRef: string | { scriptPath: string }, subArgs?: WorkflowArgs): Promise<unknown> {
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

  function realWorkflow(
    nameOrRef: string | { scriptPath: string },
    subArgs?: WorkflowArgs,
  ): Promise<unknown> {
    return trackRuntimeCall(runChildWorkflow(nameOrRef, subArgs))
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

    while (true) {
      const generation = runtimeCallGeneration
      if (pendingRuntimeCalls.size > 0) {
        await Promise.allSettled([...pendingRuntimeCalls])
      }
      await new Promise<void>(resolve => setImmediate(resolve))
      if (
        pendingRuntimeCalls.size === 0 &&
        runtimeCallGeneration === generation
      ) {
        break
      }
    }
    if (abortController.signal.aborted) {
      throw new Error('Workflow aborted')
    }

    syncRuntimeUsageFromWorkflowTask()
    const resultText = serializeWorkflowScriptResult(
      scriptResult,
      `Workflow completed. ${agentCount} agents, ${tokenSpent} tokens.`,
    )

    completeWorkflowTask(workflowTask.id, setAppState)
    const completedUsage = currentWorkflowTaskUsage()
    logWorkflowPhaseTerminals('completed')
    await emit(createWorkflowProgressEvent({ workflowRunId, status: 'completed', completedAgents: agentCount, totalAgents: agentCount }))
    await completeWorkflowRunSession({
      cwd,
      session: { ...runSession, agentCount },
      results: scriptAgentResults,
      resumeCacheEntries: journal.entries(),
      tokenCount: completedUsage.tokenCount,
      toolUseCount: completedUsage.toolUseCount,
    })

    const outputFile = await writeWorkflowResult(workflowTask.id, resultText)
    const summary = `Dynamic workflow "${plan.description}" completed`
    await enqueueWorkflowNotification({
      taskId: workflowTask.id,
      toolUseId: context.toolUseId,
      status: 'completed',
      summary,
      outputFile,
      resultText,
      failures,
      setAppState,
      usage: {
        total_tokens: completedUsage.tokenCount,
        tool_uses: completedUsage.toolUseCount,
        duration_ms: Date.now() - workflowTask.startTime,
      },
    })

    } catch (error) {
    const abortStatus = workflowAbortStatus(abortController.signal.reason)
    if (abortStatus) {
      const abortedUsage = currentWorkflowTaskUsage()
      await updateWorkflowRunSessionProgress({
        cwd,
        session: { ...runSession, agentCount },
        results: scriptAgentResults,
        resumeCacheEntries: journal.entries(),
        tokenCount: abortedUsage.tokenCount,
        toolUseCount: abortedUsage.toolUseCount,
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
        const summary = `Dynamic workflow "${plan.description}" stopped`
        const resultText = scriptAgentResults.map(result => `## ${result.agentId}\n${result.output ?? result.error ?? result.status}`).join('\n\n') || summary
        const outputFile = await writeWorkflowResult(workflowTask.id, resultText)
        await enqueueWorkflowNotification({
          taskId: workflowTask.id, toolUseId: context.toolUseId,
          status: 'killed', summary, resultText, outputFile, setAppState,
          usage: {
            total_tokens: abortedUsage.tokenCount,
            tool_uses: abortedUsage.toolUseCount,
            duration_ms: Date.now() - workflowTask.startTime,
          },
        })
      }
      return
    }

    abortController.abort()
    const message = workflowErrorMessage(error, 'Workflow script failed without error details')
    failWorkflowTask(workflowTask.id, message, setAppState)
    const failedUsage = currentWorkflowTaskUsage()
    logWorkflowPhaseTerminals('failed')
    await emit(createWorkflowProgressEvent({ workflowRunId, status: 'failed', completedAgents: agentCount, totalAgents: agentCount }))
    await failWorkflowRunSession({
      cwd,
      session: { ...runSession, agentCount },
      results: scriptAgentResults,
      error: message,
      resumeCacheEntries: journal.entries(),
      tokenCount: failedUsage.tokenCount,
      toolUseCount: failedUsage.toolUseCount,
    })
    const outputFile = await writeWorkflowResult(workflowTask.id, message)
    const summary = `Dynamic workflow "${plan.description}" failed: ${message}`
    await enqueueWorkflowNotification({
      taskId: workflowTask.id,
      toolUseId: context.toolUseId,
      status: 'failed',
      summary,
      outputFile,
      resultText: message,
      setAppState,
      usage: {
        total_tokens: failedUsage.tokenCount,
        tool_uses: failedUsage.toolUseCount,
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
