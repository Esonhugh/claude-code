import type { AssistantMessage } from '../../types/message.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import {
  completeWorkflowAgent,
  completeWorkflowTask,
  failWorkflowAgent,
  failWorkflowTask,
  recordWorkflowAgentStarted,
  recordWorkflowEvent,
  registerWorkflowTask,
  startWorkflowPhase,
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
  appendWorkflowRunEvent,
  completeWorkflowRunSession,
  failWorkflowRunSession,
  startWorkflowRunSession,
  type WorkflowRunSession,
} from './workflowRunSessions.js'
import { createWorkflowRunId } from './workflowScriptPersistence.js'

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

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

function formatWorkflowArgs(args: WorkflowArgs | undefined): string {
  if (args === undefined) return ''
  if (typeof args === 'string') return args
  return JSON.stringify(args, null, 2)
}

function buildAgentPrompt(
  phase: WorkflowDryRunPhase,
  resultsByPhase: Map<string, WorkflowAgentResult[]>,
  runArgs: WorkflowArgs | undefined,
): string {
  const parts = [phase.prompt]
  const formattedArgs = formatWorkflowArgs(runArgs).trim()
  if (formattedArgs) {
    parts.push(`Workflow user input:\n${formattedArgs}`)
  }
  const upstream = formatUpstreamOutputs(phase, resultsByPhase)
  if (upstream) parts.push(upstream)
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
): string {
  const base =
    phase.fanout > 1
      ? `${plan.name}: ${phase.id} ${index + 1}/${phase.fanout}`
      : `${plan.name}: ${phase.id}`
  return attempt === 0 ? base : `${base} retry ${attempt}/${maxRetriesFor(plan)}`
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
  resultsByPhase,
  runArgs,
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
  resultsByPhase: Map<string, WorkflowAgentResult[]>
  runArgs?: WorkflowArgs
}): Promise<WorkflowAgentResult> {
  const description = formatAgentDescription(plan, phase, index, attempt)
  const teamName =
    plan.defaults.execution === 'team' ? workflowTeamName(context) : undefined
  const input: AgentToolInput = {
    description,
    prompt: buildAgentPrompt(phase, resultsByPhase, runArgs),
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
  const fallbackAgentId = `${taskId}-${phase.id}-${index + 1}-${attempt}`
  recordWorkflowAgentStarted({
    taskId,
    phaseId: phase.id,
    agentId: fallbackAgentId,
    setAppState: context.setAppStateForTasks ?? context.setAppState,
  })

  const result = await agentTool.call(input as never, context, canUseTool, assistantMessage)
  const output = result.data as AgentToolOutput
  const agentId = resultAgentId(output, fallbackAgentId)
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
  plan,
  context,
  canUseTool,
  assistantMessage,
  taskId,
  resultsByPhase,
  runArgs,
}: {
  agentTool: Tool
  phase: WorkflowDryRunPhase
  index: number
  plan: WorkflowDryRunPlan
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  taskId: string
  resultsByPhase: Map<string, WorkflowAgentResult[]>
  runArgs?: WorkflowArgs
}): Promise<WorkflowAgentResult> {
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetriesFor(plan); attempt++) {
    try {
      return await runPhaseAgentAttempt({
        agentTool,
        phase,
        index,
        attempt,
        plan,
        context,
        canUseTool,
        assistantMessage,
        taskId,
        resultsByPhase,
        runArgs,
      })
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      failWorkflowAgent({
        taskId,
        phaseId: phase.id,
        agentId: `${taskId}-${phase.id}-${index + 1}-${attempt}`,
        error: message,
        setAppState: context.setAppStateForTasks ?? context.setAppState,
      })
    }
  }
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
}: {
  plan: WorkflowDryRunPlan
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  runArgs?: WorkflowArgs
  workflowRunId?: string
  scriptPath?: string
  resumeFromRunId?: string
}): Promise<string> {
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
  const resultsByPhase = new Map<string, WorkflowAgentResult[]>()

  const emit = async (event: WorkflowProgressEvent): Promise<void> => {
    runSession = await emitWorkflowEvent({
      cwd,
      session: runSession,
      taskId: workflowTask.id,
      event,
      setAppState,
    })
  }

  try {
    await emit({
      type: 'workflow_progress',
      workflowRunId,
      status: 'running',
      completedAgents: 0,
      totalAgents: plan.totalAgents,
    })
    await emit({
      type: 'workflow_log',
      workflowRunId,
      message: `Workflow started: ${plan.name}`,
    })

    for (const phase of plan.phases) {
      startWorkflowPhase(workflowTask.id, phase.id, setAppState)
      await emit({
        type: 'workflow_phase',
        workflowRunId,
        phaseId: phase.id,
        status: 'running',
      })
      const results: WorkflowAgentResult[] = []
      for (let index = 0; index < phase.fanout; index += phase.concurrency) {
        const batchIndexes = Array.from(
          { length: Math.min(phase.concurrency, phase.fanout - index) },
          (_, offset) => index + offset,
        )
        const batchResults = await Promise.all(
          batchIndexes.map(batchIndex =>
            runPhaseAgent({
              agentTool,
              phase,
              index: batchIndex,
              plan,
              context,
              canUseTool,
              assistantMessage,
              taskId: workflowTask.id,
              resultsByPhase,
              runArgs,
            }),
          ),
        )
        results.push(...batchResults)
        for (const result of batchResults) {
          await emit({
            type: 'workflow_agent',
            workflowRunId,
            phaseId: phase.id,
            agentId: result.agentId,
            status: result.status,
          })
        }
      }
      resultsByPhase.set(phase.id, results)
      await emit({
        type: 'workflow_phase',
        workflowRunId,
        phaseId: phase.id,
        status: 'completed',
      })
      await emit({
        type: 'workflow_progress',
        workflowRunId,
        status: 'running',
        completedAgents: [...resultsByPhase.values()].flat().length,
        totalAgents: plan.totalAgents,
      })
    }
    const allResults = [...resultsByPhase.values()].flat()
    completeWorkflowTask(workflowTask.id, setAppState)
    await emit({
      type: 'workflow_progress',
      workflowRunId,
      status: 'completed',
      completedAgents: allResults.length,
      totalAgents: plan.totalAgents,
    })
    await completeWorkflowRunSession({ cwd, session: runSession, results: allResults })
    return [
      `Workflow completed: ${plan.name}`,
      `Task ID: ${workflowTask.id}`,
      `Workflow run ID: ${workflowRunId}`,
      ...(scriptPath ? [`Script path: ${scriptPath}`] : []),
      `Agents completed: ${plan.totalAgents}`,
    ].join('\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const allResults = [...resultsByPhase.values()].flat()
    failWorkflowTask(workflowTask.id, message, setAppState)
    await emit({
      type: 'workflow_progress',
      workflowRunId,
      status: 'failed',
      completedAgents: allResults.length,
      totalAgents: plan.totalAgents,
    })
    await failWorkflowRunSession({ cwd, session: runSession, results: allResults, error: message })
    throw error
  }
}
