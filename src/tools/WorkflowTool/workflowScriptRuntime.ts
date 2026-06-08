import vm from 'node:vm'
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

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
const MAX_LOGS = 500
const SYNC_TIMEOUT_MS = 5000

type AgentToolInput = {
  description: string
  prompt: string
  subagent_type?: string
  model?: 'sonnet' | 'opus' | 'haiku'
  mode?: string
}

type AgentToolOutput = {
  status?: string
  agentId?: string
  content?: Array<{ type: string; text?: string }>
  totalTokens?: number
  totalToolUseCount?: number
  totalDurationMs?: number
}

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

export type WorkflowScriptResult = {
  result: unknown
  agentCount: number
  logs: string[]
  error?: string
}

export async function runWorkflowScript({
  script,
  plan,
  args,
  context,
  canUseTool,
  assistantMessage,
  workflowRunId = createWorkflowRunId(),
  scriptPath,
}: {
  script: string
  plan: WorkflowDryRunPlan
  args?: WorkflowArgs
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  workflowRunId?: string
  scriptPath?: string
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
    ? context.getCwd()
    : getCwd()

  let runSession = await startWorkflowRunSession({
    cwd,
    taskId: workflowTask.id,
    plan,
    runArgs: args,
    workflowRunId,
    scriptPath,
  })

  const logs: string[] = []
  let agentCount = 0
  let currentPhase: string | undefined
  const abortController = workflowTask.abortController!

  const emit = async (event: WorkflowProgressEvent): Promise<void> => {
    recordWorkflowEvent({ taskId: workflowTask.id, event, setAppState })
    runSession = await appendWorkflowRunEvent({ cwd, session: runSession, event })
  }

  // Real agent() implementation — calls AgentTool
  async function realAgent(
    prompt: string,
    opts?: { label?: string; phase?: string; schema?: object; model?: string; agentType?: string },
  ): Promise<unknown> {
    if (abortController.signal.aborted) return null
    agentCount++
    const label = opts?.label || `agent-${agentCount}`
    const phase = opts?.phase || currentPhase || label

    startWorkflowPhase(workflowTask.id, phase, setAppState)
    recordWorkflowAgentStarted({
      taskId: workflowTask.id,
      phaseId: phase,
      agentId: label,
      setAppState,
    })

    const agentAbortController = createChildAbortController(abortController)
    recordWorkflowAgentController({
      taskId: workflowTask.id,
      agentId: label,
      abortController: agentAbortController,
      setAppState,
      baseAgentId: label,
      index: agentCount - 1,
      userRetryAttempt: 0,
    })

    // Build description for progress display
    const description = `${plan.name}: ${label}`

    let schemaInstruction = ''
    if (opts?.schema) {
      schemaInstruction = '\n\nYou MUST respond with valid JSON matching this schema:\n' +
        JSON.stringify(opts.schema, null, 2) +
        '\n\nReturn ONLY the JSON object, no other text.'
    }

    const input: AgentToolInput = {
      description,
      prompt: prompt + schemaInstruction,
      subagent_type: opts?.agentType,
      model: opts?.model as AgentToolInput['model'],
    }

    try {
      const result = await agentTool.call(
        input as never,
        { ...context, abortController: agentAbortController },
        canUseTool,
        assistantMessage,
        (progress) => {
          const data = (progress as { data?: { type?: string } })?.data
          if (data?.type === 'agent_progress') {
            recordWorkflowAgentProgress({
              taskId: workflowTask.id,
              agentId: label,
              tokenCount: 0,
              toolUseCount: 0,
              setAppState,
            })
          }
        },
      )
      const output = result.data as AgentToolOutput
      const text = extractAgentText(output)

      completeWorkflowAgent({
        taskId: workflowTask.id,
        result: {
          phaseId: phase,
          agentId: label,
          index: agentCount - 1,
          status: 'completed',
          output: text,
          tokenCount: output.totalTokens ?? 0,
          toolUseCount: output.totalToolUseCount ?? 0,
          durationMs: output.totalDurationMs ?? 0,
        },
        setAppState,
      })

      // If schema was requested, try to parse JSON from response
      if (opts?.schema) {
        try {
          // Try to extract JSON from the response
          const jsonMatch = text.match(/\{[\s\S]*\}/)
          if (jsonMatch) return JSON.parse(jsonMatch[0])
        } catch { /* fall through to raw text */ }
      }
      return text || null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failWorkflowAgent({
        taskId: workflowTask.id,
        phaseId: phase,
        agentId: label,
        error: message,
        setAppState,
      })
      return null
    }
  }

  // Real parallel() — Promise.all with catch→null
  async function realParallel<T>(thunks: Array<() => Promise<T> | T>): Promise<Array<T | null>> {
    return Promise.all(
      thunks.map(async thunk => {
        try {
          return await thunk()
        } catch {
          return null
        }
      }),
    )
  }

  // Real pipeline() — no barrier between stages
  async function realPipeline<T>(items: T[], ...stages: Array<(val: any, orig: any, idx: number) => any>): Promise<any[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of stages) {
          if (value === null) break
          try {
            value = await stage(value, item, index)
          } catch {
            value = null
          }
        }
        return value
      }),
    )
  }

  try {
    await emit(createWorkflowProgressEvent({
      workflowRunId,
      status: 'running',
      completedAgents: 0,
      totalAgents: plan.totalAgents,
    }))
    await emit(createWorkflowLogEvent({ workflowRunId, message: `Workflow script started: ${plan.name}` }))

    const parsed = parseWorkflowScript(script)

    // Create VM sandbox with real implementations
    const sandbox = vm.createContext({
      args,
      agent: realAgent,
      pipeline: realPipeline,
      parallel: realParallel,
      phase(title: string) {
        currentPhase = title
        startWorkflowPhase(workflowTask.id, title, setAppState)
        emit(createWorkflowPhaseEvent({ workflowRunId, phaseId: title, status: 'running' }))
      },
      log(message: string) {
        if (logs.length < MAX_LOGS) logs.push(message)
        emit(createWorkflowLogEvent({ workflowRunId, message }))
      },
      budget: {
        total: null,
        spent: () => agentCount,
        remaining: () => Infinity,
      },
      Date: Object.assign(
        () => { throw new Error('Date() unavailable in workflow scripts') },
        { now: () => { throw new Error('Date.now() unavailable') }, parse: Date.parse, UTC: Date.UTC },
      ),
      Math: (() => {
        const m = Object.create(Math)
        Object.defineProperty(m, 'random', { value: () => { throw new Error('Math.random() unavailable') } })
        return Object.freeze(m)
      })(),
      URL,
      console: { log: (msg: string) => { if (logs.length < MAX_LOGS) logs.push(String(msg)) } },
    })

    const scriptCode = new vm.Script(
      `(async () => {\n${parsed.scriptBody}\n})()`,
      { filename: scriptPath || 'workflow-script.js' },
    )

    const resultPromise = scriptCode.runInContext(sandbox, { timeout: SYNC_TIMEOUT_MS })

    // Await with abort support
    const scriptResult = await Promise.race([
      resultPromise,
      new Promise((_, reject) => {
        if (abortController.signal.aborted) reject(new Error('Workflow aborted'))
        else abortController.signal.addEventListener('abort', () => reject(new Error('Workflow aborted')))
      }),
    ])

    completeWorkflowTask(workflowTask.id, setAppState)
    await emit(createWorkflowProgressEvent({
      workflowRunId,
      status: 'completed',
      completedAgents: agentCount,
      totalAgents: agentCount,
    }))
    await completeWorkflowRunSession({
      cwd,
      session: runSession,
      results: [],
      resumeCacheEntries: [],
    })

    // Format result
    const resultText = scriptResult !== undefined && scriptResult !== null
      ? (typeof scriptResult === 'string' ? scriptResult : JSON.stringify(scriptResult, null, 2))
      : `Workflow completed. ${agentCount} agents executed.`

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
    await emit(createWorkflowProgressEvent({
      workflowRunId,
      status: 'failed',
      completedAgents: agentCount,
      totalAgents: plan.totalAgents,
    }))
    await failWorkflowRunSession({
      cwd,
      session: runSession,
      results: [],
      error: message,
      resumeCacheEntries: [],
    })
    throw error
  }
}
