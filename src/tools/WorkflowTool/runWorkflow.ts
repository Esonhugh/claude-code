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
  registerWorkflowTask,
  startWorkflowPhase,
  type WorkflowAgentResult,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type {
  WorkflowDryRunPhase,
  WorkflowDryRunPlan,
  WorkflowPermissionMode,
} from './workflowSpec.js'
import {
  completeWorkflowRunSession,
  failWorkflowRunSession,
  startWorkflowRunSession,
} from './workflowRunSessions.js'

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

function buildAgentPrompt(
  phase: WorkflowDryRunPhase,
  resultsByPhase: Map<string, WorkflowAgentResult[]>,
  runArgs: string | undefined,
): string {
  const parts = [phase.prompt]
  if (runArgs?.trim()) {
    parts.push(`Workflow user input:\n${runArgs.trim()}`)
  }
  const upstream = formatUpstreamOutputs(phase, resultsByPhase)
  if (upstream) parts.push(upstream)
  return parts.join('\n\n')
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
  runArgs?: string
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
  runArgs?: string
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
}: {
  plan: WorkflowDryRunPlan
  context: ToolUseContext
  canUseTool: CanUseToolFn
  assistantMessage: AssistantMessage
  runArgs?: string
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
  })
  const cwd = workflowCwd(context)
  const runSession = await startWorkflowRunSession({
    cwd,
    taskId: workflowTask.id,
    plan,
    runArgs,
  })
  const resultsByPhase = new Map<string, WorkflowAgentResult[]>()

  try {
    for (const phase of plan.phases) {
      startWorkflowPhase(workflowTask.id, phase.id, setAppState)
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
      }
      resultsByPhase.set(phase.id, results)
    }
    const allResults = [...resultsByPhase.values()].flat()
    completeWorkflowTask(workflowTask.id, setAppState)
    await completeWorkflowRunSession({ cwd, session: runSession, results: allResults })
    return [
      `Workflow completed: ${plan.name}`,
      `Task ID: ${workflowTask.id}`,
      `Agents completed: ${plan.totalAgents}`,
    ].join('\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const allResults = [...resultsByPhase.values()].flat()
    failWorkflowTask(workflowTask.id, message, setAppState)
    await failWorkflowRunSession({ cwd, session: runSession, results: allResults, error: message })
    throw error
  }
}
