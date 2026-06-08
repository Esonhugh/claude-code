import vm from 'node:vm'
import { availableParallelism } from 'node:os'
import { createHash } from 'node:crypto'
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
import type { WorkflowArgs, WorkflowDryRunPlan, WorkflowProgressEvent } from './workflowSpec.js'
import {
  createWorkflowLogEvent,
  createWorkflowPhaseEvent,
  createWorkflowProgressEvent,
} from './workflowEvents.js'
import {
  appendWorkflowRunEvent,
  completeWorkflowRunSession,
  failWorkflowRunSession,
  startWorkflowRunSession,
  type WorkflowRunSession,
} from './workflowRunSessions.js'
import { createWorkflowRunId } from './workflowScriptPersistence.js'
import { parseWorkflowScript } from './workflowScriptParser.js'
import { getCwd } from '../../utils/cwd.js'

// --- Constants ---
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const MAX_LOGS = 1000
const SYNC_TIMEOUT_MS = 5000
const MAX_CONCURRENCY = Math.min(16, Math.max(2, availableParallelism() - 2))
const MAX_AGENT_CAP = 1000
const MAX_STALL_RETRIES = 3
const DEFAULT_STALL_MS = 120_000
const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'

// --- Types ---
type AgentToolInput = {
  description: string
  prompt: string
  subagent_type?: string
  model?: 'sonnet' | 'opus' | 'haiku'
  mode?: string
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
  isolation?: 'worktree'
  stallMs?: number
}

type JournalEntry = { key: string; result: unknown }

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
  private cache = new Map<string, unknown>()
  record(key: string, result: unknown): void { this.cache.set(key, result) }
  lookup(key: string): { hit: true; result: unknown } | { hit: false } {
    if (this.cache.has(key)) return { hit: true, result: this.cache.get(key) }
    return { hit: false }
  }
  entries(): JournalEntry[] {
    return [...this.cache.entries()].map(([key, result]) => ({ key, result }))
  }
  loadFrom(entries: JournalEntry[]): void {
    for (const { key, result } of entries) this.cache.set(key, result)
  }
}

function agentIdentityKey(prompt: string, opts?: AgentOpts): string {
  const h = createHash('sha256')
  h.update(prompt)
  if (opts?.label) h.update(opts.label)
  if (opts?.model) h.update(opts.model)
  if (opts?.schema) h.update(JSON.stringify(opts.schema))
  return h.digest('hex').slice(0, 16)
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
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
  resumeJournalEntries?: JournalEntry[]
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

  let runSession = await startWorkflowRunSession({
    cwd, taskId: workflowTask.id, plan, runArgs: args, workflowRunId, scriptPath,
  })

  const logs: string[] = []
  let agentCount = 0
  let tokenSpent = 0
  let currentPhase: string | undefined
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

    // Journal cache hit
    const cached = journal.lookup(identityKey)
    if (cached.hit) return cached.result

    agentCount++
    const phase = opts?.phase || currentPhase || label
    const stallMs = opts?.stallMs ?? DEFAULT_STALL_MS

    startWorkflowPhase(workflowTask.id, phase, setAppState)

    // Stall retry loop
    for (let attempt = 1; attempt <= MAX_STALL_RETRIES; attempt++) {
      await semaphore.acquire()
      try {
        const result = await runSingleAgent(prompt, opts, label, phase, stallMs)
        // Record in journal
        journal.record(identityKey, result)
        return result
      } catch (error) {
        if (abortController.signal.aborted) return null
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('stalled') && attempt < MAX_STALL_RETRIES) {
          logs.push(`[stall] agent "${label}" stalled, retry ${attempt}/${MAX_STALL_RETRIES}`)
          continue
        }
        // Non-stall error or max retries — fail gracefully (return null like official parallel)
        failWorkflowAgent({
          taskId: workflowTask.id, phaseId: phase, agentId: label,
          error: msg, setAppState,
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
    label: string, phase: string, stallMs: number,
  ): Promise<unknown> {
    recordWorkflowAgentStarted({ taskId: workflowTask.id, phaseId: phase, agentId: label, setAppState })
    const agentAbortController = createChildAbortController(abortController)
    recordWorkflowAgentController({
      taskId: workflowTask.id, agentId: label,
      abortController: agentAbortController, setAppState,
      baseAgentId: label, index: agentCount - 1, userRetryAttempt: 0,
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
      ...(opts?.isolation === 'worktree' ? { isolation: 'worktree' } : {}),
    }

    try {
      const result = await agentTool.call(
        input as never,
        { ...context, abortController: agentAbortController },
        canUseTool, assistantMessage,
        () => { lastProgress = Date.now() },
      )
      clearInterval(stallTimer)

      const output = result.data as AgentToolOutput
      const text = extractAgentText(output)
      tokenSpent += output.totalTokens ?? 0

      completeWorkflowAgent({
        taskId: workflowTask.id,
        result: {
          phaseId: phase, agentId: label, index: agentCount - 1,
          status: 'completed', output: text,
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

  // --- workflow() sub-call ---
  async function realWorkflow(nameOrRef: string | { scriptPath: string }, subArgs?: WorkflowArgs): Promise<unknown> {
    // For now, throw — full recursive implementation needs workflow discovery
    throw new Error(`workflow() sub-calls are not yet supported in this runtime. Called with: ${typeof nameOrRef === 'string' ? nameOrRef : nameOrRef.scriptPath}`)
  }

  // --- Execute ---
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
        currentPhase = title
        startWorkflowPhase(workflowTask.id, title, setAppState)
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
    await completeWorkflowRunSession({ cwd, session: runSession, results: [], resumeCacheEntries: [] })

    const resultText = scriptResult != null
      ? (typeof scriptResult === 'string' ? scriptResult : JSON.stringify(scriptResult, null, 2))
      : `Workflow completed. ${agentCount} agents, ${tokenSpent} tokens.`

    return [
      `Workflow launched in background. Task ID: ${workflowTask.id}`,
      `Run ID: ${workflowRunId}`,
      `Result:\n${resultText}`,
      logs.length > 0 ? `Logs:\n${logs.join('\n')}` : '',
      'Use /workflows to watch live progress.',
    ].filter(Boolean).join('\n')
  } catch (error) {
    abortController.abort()
    const message = error instanceof Error ? error.message : String(error)
    failWorkflowTask(workflowTask.id, message, setAppState)
    await emit(createWorkflowProgressEvent({ workflowRunId, status: 'failed', completedAgents: agentCount, totalAgents: plan.totalAgents }))
    await failWorkflowRunSession({ cwd, session: runSession, results: [], error: message, resumeCacheEntries: [] })
    throw error
  }
}
