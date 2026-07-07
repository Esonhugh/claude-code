import vm from 'node:vm'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { AssistantMessage } from '../../types/message.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
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
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowAgentErrorKind } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowArgs, WorkflowDryRunPhase, WorkflowDryRunPlan, WorkflowPermissionMode, WorkflowProgressEvent } from './workflowSpec.js'
import { createWorkflowScriptAgentIdentity, type WorkflowResumeCacheEntry } from './workflowResumeCache.js'
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
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { emitTaskTerminatedSdk } from '../../utils/sdkEventQueue.js'
import { getProjectTempDir } from '../../utils/permissions/filesystem.js'
import {
  appendWorkflowJournalResult,
  appendWorkflowJournalStarted,
} from './workflowJournal.js'
import { loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'
import { loadWorkflowScriptSpec } from './workflowDsl.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'
import { workflowPhaseExecutionOrder } from './workflowPhaseScheduler.js'

// --- Constants ---
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const MAX_LOGS = 1000
const SYNC_TIMEOUT_MS = 5000
const MAX_CONCURRENCY = Math.min(16, Math.max(2, availableParallelism() - 2))
const MAX_AGENT_CAP = 1000
const MAX_STALL_RETRIES = 3
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
  private queue: Array<() => void> = []
  private active = 0
  constructor(private max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) { this.active++; return }
    await new Promise<void>(resolve => this.queue.push(resolve))
  }
  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) { this.active++; next() }
  }
}

// --- Journal (Resume Cache) ---
class WorkflowJournal {
  private cache = new Map<string, WorkflowResumeCacheEntry>()
  record(identity: string, result: unknown, input: { index: number; phase?: string; label?: string; completedAt?: number }): void {
    this.cache.set(identity, {
      index: input.index,
      identity,
      phase: input.phase,
      label: input.label,
      result,
      completedAt: input.completedAt ?? Date.now(),
    })
  }
  lookup(identity: string): { hit: true; result: unknown } | { hit: false } {
    const entry = this.cache.get(identity)
    if (entry) return { hit: true, result: entry.result }
    return { hit: false }
  }
  entries(): WorkflowResumeCacheEntry[] {
    return [...this.cache.values()]
  }
  loadFrom(entries: WorkflowResumeCacheEntry[]): void {
    for (const entry of entries) this.cache.set(entry.identity, entry)
  }
}

function mapPermissionMode(mode: WorkflowPermissionMode | undefined): WorkflowPermissionMode | undefined {
  return mode === 'default' ? undefined : mode
}

function agentIdentityKey(prompt: string, opts?: AgentOpts): string {
  return createWorkflowScriptAgentIdentity(prompt, {
    agentType: opts?.agentType,
    isolation: opts?.isolation,
    label: opts?.label,
    mode: mapPermissionMode(opts?.mode),
    model: opts?.model,
    phase: opts?.phase,
    schema: opts?.schema,
  })
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

function tryParseStructuredOutput(text: string): unknown | undefined {
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch { /* ignore */ }
  return undefined
}

function workflowProgressSnapshot(plan: WorkflowDryRunPlan): Array<{ type: string; index: number; phaseIndex?: number; label?: string; status?: string; message?: string }> {
  return plan.phases.flatMap((phase, phaseIndex) => [
    { type: 'phase', index: phaseIndex, label: phase.id, status: 'running', message: phase.description },
    ...Array.from({ length: phase.fanout }, (_, index) => ({
      type: 'agent',
      index,
      phaseIndex,
      label: phase.agentLabels?.[index] ?? `${phase.id}-${index + 1}`,
      status: 'pending',
    })),
  ])
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
  })
  const cwd = 'getCwd' in context && typeof context.getCwd === 'function'
    ? context.getCwd() : getCwd()

  const transcriptDir = workflowTranscriptDir(workflowRunId)
  let runSession = await startWorkflowRunSession({
    cwd, taskId: workflowTask.id, plan, runArgs: args, workflowRunId, scriptPath, transcriptDir, resumeFromRunId,
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
  function checkAgentCap() {
    if (agentCount >= MAX_AGENT_CAP) {
      throw new Error(`Workflow agent cap exceeded: ${MAX_AGENT_CAP}`)
    }
  }

  // --- Real agent() with stall detection, retry, schema, worktree ---
  async function realAgent(
    prompt: string,
    opts?: AgentOpts,
  ): Promise<unknown> {
    if (abortController.signal.aborted) return null
    checkAgentCap()
    checkBudget()

    const label = opts?.label || `agent-${agentCount + 1}`
    const identityKey = agentIdentityKey(prompt, opts)
    const phase = opts?.phase || currentPhaseId
    const agentIndex = agentCount
    agentCount++

    startWorkflowPhase(workflowTask.id, phase, setAppState)
    recordWorkflowAgentStarted({ taskId: workflowTask.id, phaseId: phase, agentId: label, setAppState })

    await appendWorkflowJournalStarted(transcriptDir, {
      key: identityKey,
      agentId: label,
      phase,
      label,
      index: agentIndex,
      timestamp: Date.now(),
    })

    // Journal cache hit
    const cached = journal.lookup(identityKey)
    if (cached.hit) {
      const output = typeof cached.result === 'string'
        ? cached.result
        : JSON.stringify(cached.result) ?? String(cached.result)
      completeWorkflowAgent({
        taskId: workflowTask.id,
        result: {
          phaseId: phase,
          agentId: label,
          index: agentIndex,
          status: 'completed',
          output,
          prompt,
          tokenCount: 0,
          toolUseCount: 0,
          durationMs: 0,
        },
        setAppState,
      })
      await appendWorkflowJournalResult(transcriptDir, {
        key: identityKey,
        agentId: label,
        phase,
        label,
        index: agentIndex,
        result: cached.result,
        timestamp: Date.now(),
      })
      await emit(createWorkflowAgentEvent({ workflowRunId, phaseId: phase, agentId: label, status: 'completed', cacheHit: true }))
      return cached.result
    }

    const stallMs = opts?.stallMs ?? DEFAULT_STALL_MS

    // Stall retry loop
    for (let attempt = 1; attempt <= MAX_STALL_RETRIES; attempt++) {
      await semaphore.acquire()
      try {
        const result = await runSingleAgent(prompt, opts, label, phase, stallMs, agentIndex)
        const completedAt = Date.now()
        journal.record(identityKey, result, { index: agentIndex, phase, label, completedAt })
        await appendWorkflowJournalResult(transcriptDir, {
          key: identityKey,
          agentId: label,
          phase,
          label,
          index: agentIndex,
          result,
          timestamp: completedAt,
        })
        return result
      } catch (error) {
        if (abortController.signal.aborted) return null
        const msg = workflowErrorMessage(error, `Workflow agent failed without error details: ${label}`)
        if (msg.includes('stalled') && attempt < MAX_STALL_RETRIES) {
          logs.push(`[stall] agent "${label}" stalled, retry ${attempt}/${MAX_STALL_RETRIES}`)
          continue
        }
        // Non-stall error or max retries — fail gracefully (return null like official parallel)
        failWorkflowAgent({
          taskId: workflowTask.id, phaseId: phase, agentId: label,
          error: msg, errorKind: classifyWorkflowAgentError(error), setAppState,
        })
        const completedAt = Date.now()
        journal.record(identityKey, null, { index: agentIndex, phase, label, completedAt })
        await appendWorkflowJournalResult(transcriptDir, {
          key: identityKey,
          agentId: label,
          phase,
          label,
          index: agentIndex,
          result: null,
          timestamp: completedAt,
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
    label: string, phase: string, stallMs: number, agentIndex: number,
  ): Promise<unknown> {
    const agentAbortController = createChildAbortController(abortController)
    recordWorkflowAgentController({
      taskId: workflowTask.id, agentId: label,
      abortController: agentAbortController, setAppState,
      baseAgentId: label, index: agentIndex, userRetryAttempt: 0,
    })

    // Stall timer
    let lastProgress = Date.now()
    const stallTimer = setInterval(() => {
      if (Date.now() - lastProgress > stallMs) {
        agentAbortController.abort('stalled')
      }
    }, Math.min(stallMs / 2, 30_000))

    const description = `${plan.name}: ${label}`
    const schemaPrompt = opts?.schema ? buildSchemaPrompt(opts.schema) : ''

    const input: AgentToolInput = {
      description,
      prompt: prompt + schemaPrompt,
      subagent_type: opts?.agentType,
      model: opts?.model as AgentToolInput['model'],
      mode: mapPermissionMode(opts?.mode ?? plan.defaults.permissionMode),
      ...(opts?.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
    }

    try {
      const progressPhase = childWorkflowProgressName ?? phase
      emitTaskProgress({
        taskId: workflowTask.id,
        toolUseId: context.toolUseId,
        description: workflowAgentProgressDescription(progressPhase, label, plan),
        startTime: workflowTask.startTime,
        totalTokens: tokenSpent,
        toolUses: 0,
        lastToolName: label,
        summary: `Workflow agent started: ${label}`,
        workflowProgress: workflowProgressSnapshot(plan),
      })

      const result = await agentTool.call(
        input as never,
        {
          ...context,
          abortController: agentAbortController,
          options: {
            ...context.options,
            disableNestedAgentTools: true,
          },
        },
        canUseTool, assistantMessage,
        (progress) => {
          lastProgress = Date.now()
          // Update liveAgents with progress info for UI
          const p = progress?.data as { summary?: string } | undefined
          if (p?.summary) {
            recordWorkflowAgentProgress({
              taskId: workflowTask.id, agentId: label,
              tokenCount: 0, toolUseCount: 0,
              activity: p.summary, prompt: prompt.slice(0, 200),
              setAppState,
            })
          }
        },
      )
      clearInterval(stallTimer)

      const output = result.data as AgentToolOutput
      const text = extractAgentText(output)
      tokenSpent += output.totalTokens ?? 0
      toolUseSpent += output.totalToolUseCount ?? 0

      emitTaskProgress({
        taskId: workflowTask.id,
        toolUseId: context.toolUseId,
        description: workflowAgentProgressDescription(progressPhase, label, plan),
        startTime: workflowTask.startTime,
        totalTokens: tokenSpent,
        toolUses: toolUseSpent,
        lastToolName: label,
        summary: `Workflow agent completed: ${label}`,
        workflowProgress: workflowProgressSnapshot(plan),
      })

      completeWorkflowAgent({
        taskId: workflowTask.id,
        result: {
          phaseId: phase, agentId: label, index: agentIndex,
          status: 'completed', output: text, prompt,
          tokenCount: output.totalTokens ?? 0,
          toolUseCount: output.totalToolUseCount ?? 0,
          durationMs: output.totalDurationMs ?? 0,
        },
        setAppState,
      })

      if (opts?.schema) {
        const parsed = tryParseStructuredOutput(text)
        if (parsed !== undefined) return parsed
      }
      return text || null
    } catch (error) {
      clearInterval(stallTimer)
      if (agentAbortController.signal.reason === 'stalled') {
        throw new Error('stalled')
      }
      throw error
    }
  }

  // --- parallel(): Promise.allSettled, errors → null ---
  async function realParallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>> {
    if (abortController.signal.aborted) return thunks.map(() => null)
    checkBudget()
    const results = await Promise.allSettled(thunks.map(async thunk => await thunk()))
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      logs.push(`parallel[${i}] failed: ${msg}`)
      return null
    })
  }

  // --- pipeline(): no barrier between stages, per-item ---
  async function realPipeline<T>(items: T[], ...stages: Array<(val: any, orig: any, idx: number) => any>): Promise<any[]> {
    if (abortController.signal.aborted) return items.map(() => null)
    checkBudget()
    return Promise.all(
      items.map(async (item, index) => {
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
    const childSandbox = vm.createContext({
      args: subArgs,
      agent: realAgent,
      pipeline: realPipeline,
      parallel: realParallel,
      workflow: () => Promise.reject(childWorkflowNestingError()),
      phase(title: string) {
        currentPhaseId = title
        emit(createWorkflowPhaseEvent({ workflowRunId, phaseId: title, status: 'running' }))
      },
      log(message: string) {
        if (logs.length < MAX_LOGS) logs.push(String(message))
        emit(createWorkflowLogEvent({ workflowRunId, message: String(message) }))
      },
      budget: Object.freeze({ get total() { return budget.total }, spent: budget.spent, remaining: budget.remaining }),
      Date: Object.assign(
        () => { throw new Error('Date() unavailable in workflow scripts (breaks resume)') },
        { now: () => { throw new Error('Date.now() unavailable') }, parse: Date.parse, UTC: Date.UTC },
      ),
      Math: (() => {
        const m = Object.create(Math)
        Object.defineProperty(m, 'random', { value: () => { throw new Error('Math.random() unavailable (breaks resume)') } })
        return Object.freeze(m)
      })(),
      URL,
      console: { log: (msg: unknown) => { if (logs.length < MAX_LOGS) logs.push(String(msg)) } },
    })
    return await new vm.Script(`(async () => {\n${parsed.scriptBody}\n})()`, {
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
      await emit(createWorkflowProgressEvent({ workflowRunId, status: 'running', completedAgents: 0, totalAgents: plan.totalAgents }))
    await emit(createWorkflowLogEvent({ workflowRunId, message: `Workflow script started: ${plan.name}` }))

    const parsed = parseWorkflowScript(script)
    const sandbox = vm.createContext({
      args,
      agent: realAgent,
      pipeline: realPipeline,
      parallel: realParallel,
      workflow: realWorkflow,
      phase(title: string) {
        currentPhaseId = title
        emit(createWorkflowPhaseEvent({ workflowRunId, phaseId: title, status: 'running' }))
      },
      log(message: string) {
        if (logs.length < MAX_LOGS) logs.push(String(message))
        emit(createWorkflowLogEvent({ workflowRunId, message: String(message) }))
      },
      budget: Object.freeze({ get total() { return budget.total }, spent: budget.spent, remaining: budget.remaining }),
      Date: Object.assign(
        () => { throw new Error('Date() unavailable in workflow scripts (breaks resume)') },
        { now: () => { throw new Error('Date.now() unavailable') }, parse: Date.parse, UTC: Date.UTC },
      ),
      Math: (() => {
        const m = Object.create(Math)
        Object.defineProperty(m, 'random', { value: () => { throw new Error('Math.random() unavailable (breaks resume)') } })
        return Object.freeze(m)
      })(),
      URL,
      console: { log: (msg: unknown) => { if (logs.length < MAX_LOGS) logs.push(String(msg)) } },
    })

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

    completeWorkflowTask(workflowTask.id, setAppState)
    await emit(createWorkflowProgressEvent({ workflowRunId, status: 'completed', completedAgents: agentCount, totalAgents: agentCount }))
    await completeWorkflowRunSession({ cwd, session: runSession, results: [], resumeCacheEntries: journal.entries() })

    const resultText = scriptResult != null
      ? (typeof scriptResult === 'string' ? scriptResult : JSON.stringify(scriptResult, null, 2))
      : `Workflow completed. ${agentCount} agents, ${tokenSpent} tokens.`
    const outputFile = await writeWorkflowResult(workflowTask.id, resultText)
    emitTaskTerminatedSdk(workflowTask.id, 'completed', {
      toolUseId: context.toolUseId,
      summary: `Dynamic workflow "${plan.description}" completed`,
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
        results: [],
        resumeCacheEntries: journal.entries(),
      })
      await updateWorkflowRunSessionStatus({
        cwd,
        workflowRunId,
        status: abortStatus,
        ...(abortStatus === 'paused' && scriptPath
          ? { resumePrompt: `Workflow({scriptPath: "${scriptPath}", resumeFromRunId: "${workflowRunId}"})` }
          : {}),
      })
      return
    }

    abortController.abort()
    const message = workflowErrorMessage(error, 'Workflow script failed without error details')
    failWorkflowTask(workflowTask.id, message, setAppState)
    await emit(createWorkflowProgressEvent({ workflowRunId, status: 'failed', completedAgents: agentCount, totalAgents: plan.totalAgents }))
    await failWorkflowRunSession({ cwd, session: runSession, results: [], error: message, resumeCacheEntries: journal.entries() })
    const outputFile = await writeWorkflowResult(workflowTask.id, message)
    emitTaskTerminatedSdk(workflowTask.id, 'failed', {
      toolUseId: context.toolUseId,
      summary: `Dynamic workflow "${plan.description}" failed: ${message}`,
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
