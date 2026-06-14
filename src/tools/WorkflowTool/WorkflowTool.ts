import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { formatWorkflowStatus } from '../../tasks/LocalWorkflowTask/formatWorkflowStatus.js'
import {
  pauseWorkflowTask,
  resumeWorkflowTask,
  type LocalWorkflowTaskState,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatWorkflowDryRun } from './formatWorkflowDryRun.js'
import { runWorkflowPlan } from './runWorkflow.js'
import { runWorkflowScript } from './workflowScriptRuntime.js'
import type { WorkflowDryRunPlan, WorkflowProgressEvent, WorkflowSpec } from './workflowSpec.js'
import { updateWorkflowRunSessionStatus } from './workflowRunSessions.js'
import {
  discoverWorkflowSpecs,
  loadWorkflowSpecByNameOrPath,
} from './workflowDiscovery.js'
import { workflowPermissionPreviewInput } from './workflowPermissionPreviewInput.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'
import { hasWorkflowScriptMeta } from './workflowScriptParser.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['list', 'show', 'dry-run', 'run', 'status', 'pause', 'resume'])
      .describe('Workflow action to perform'),
    selector: z
      .string()
      .optional()
      .describe('Workflow command name, display name, or JSON file path for show/dry-run/run'),
    plan: z
      .unknown()
      .optional()
      .describe('Validated workflow dry-run plan for direct runtime execution'),
    runArgs: z
      .string()
      .optional()
      .describe('User-supplied workflow run input/context'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.string())
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type WorkflowToolContext = {
  getCwd?: () => string
}

function resolveCwd(context: WorkflowToolContext | unknown): string {
  if (
    context &&
    typeof context === 'object' &&
    'getCwd' in context &&
    typeof context.getCwd === 'function'
  ) {
    return context.getCwd()
  }
  return getCwd()
}

function loadWorkflowTask(
  context: { getAppState?: () => { tasks?: Record<string, unknown> } },
  selector: string,
): LocalWorkflowTaskState {
  const task = context.getAppState?.().tasks?.[selector]
  if (!task || typeof task !== 'object' || !('type' in task) || task.type !== 'local_workflow') {
    throw new Error(`Workflow task not found: ${selector}`)
  }
  return task as LocalWorkflowTaskState
}

function loadWorkflowTaskStatus(context: { getAppState?: () => { tasks?: Record<string, unknown> } }, selector: string): string {
  return formatWorkflowStatus(loadWorkflowTask(context, selector))
}

function latestWorkflowProgressEvent(task: LocalWorkflowTaskState): WorkflowProgressEvent | undefined {
  return task.events
    .slice()
    .reverse()
    .find(event => event.type === 'workflow_progress')
}

function normalizeExecutableWorkflowPlan(plan: unknown): WorkflowDryRunPlan {
  if (!plan || typeof plan !== 'object') {
    throw new Error('Invalid executable workflow plan: plan must be an object')
  }
  try {
    return validateWorkflowSpec(plan as WorkflowSpec)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid executable workflow plan: ${message}`)
  }
}

async function persistWorkflowControlStatus({
  cwd,
  task,
  status,
}: {
  cwd: string
  task: LocalWorkflowTaskState
  status: 'paused' | 'running'
}): Promise<void> {
  if (!task.workflowRunId) return
  await updateWorkflowRunSessionStatus({
    cwd,
    workflowRunId: task.workflowRunId,
    status,
    event: latestWorkflowProgressEvent(task),
    ...(task.summary?.includes('Workflow({scriptPath:') ? { resumePrompt: task.summary } : {}),
  })
}

async function listWorkflows(cwd: string): Promise<string> {
  const discovery = await discoverWorkflowSpecs(cwd)
  const lines: string[] = []

  if (discovery.valid.length === 0) {
    lines.push('No workflow specs found in docs/workflows or .claude/workflows')
  } else {
    lines.push('Workflow specs:')
    for (const workflow of discovery.valid) {
      lines.push(`- ${workflow.commandName}: ${workflow.plan.description}`)
      lines.push(`  source: ${workflow.path}`)
    }
  }

  if (discovery.invalid.length > 0) {
    lines.push('', 'Invalid workflow specs:')
    for (const invalid of discovery.invalid) {
      lines.push(`- ${invalid.path}: ${invalid.error}`)
    }
  }

  return lines.join('\n')
}

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'inspect workflow specs',
  maxResultSizeChars: 100_000,
  async description() {
    return 'List, show, and dry-run workflow specs'
  },
  async prompt() {
    return `Use this tool to inspect or execute validated workflow specs. Use action "list" to discover workflows, "show" to inspect metadata, "dry-run" to view the planned phase graph, "run" to execute phases through the Agent tool, "status" to inspect a workflow task by id, and "pause" or "resume" to control a workflow task. Workflow execution records LocalWorkflowTask phase state and does not directly use shell or filesystem tools.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly(input) {
    return !['run', 'pause', 'resume'].includes(input.action)
  },
  async checkPermissions(input, context) {
    if (input.action === 'run') {
      const cwd = resolveCwd(context)
      return {
        behavior: 'ask',
        message: 'Run a dynamic workflow?',
        updatedInput: await workflowPermissionPreviewInput(input, cwd),
      }
    }
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage(input) {
    const action = input.action ?? 'list'
    const selector = input.selector ? ` ${input.selector}` : ''
    return `Workflow ${action}${selector}`
  },
  async call(input, context, canUseTool, assistantMessage) {
    const { action, selector, plan, runArgs } = input
    const cwd = resolveCwd(context)

    if (action === 'list') {
      return { data: await listWorkflows(cwd) }
    }

    if (action === 'run' && plan && !selector?.trim()) {
      const executablePlan = normalizeExecutableWorkflowPlan(plan)
      return {
        data: await runWorkflowPlan({
          plan: executablePlan,
          context,
          canUseTool,
          assistantMessage,
          runArgs,
        }),
      }
    }

    if (!selector?.trim()) {
      throw new Error(`Workflow ${action} requires a selector`)
    }

    if (action === 'status') {
      return { data: loadWorkflowTaskStatus(context, selector) }
    }

    if (action === 'pause') {
      loadWorkflowTask(context, selector)
      pauseWorkflowTask(selector, context.setAppStateForTasks ?? context.setAppState)
      const task = loadWorkflowTask(context, selector)
      await persistWorkflowControlStatus({ cwd, task, status: 'paused' })
      return { data: formatWorkflowStatus(task) }
    }

    if (action === 'resume') {
      loadWorkflowTask(context, selector)
      resumeWorkflowTask(selector, context.setAppStateForTasks ?? context.setAppState)
      const task = loadWorkflowTask(context, selector)
      await persistWorkflowControlStatus({ cwd, task, status: 'running' })
      return { data: formatWorkflowStatus(task) }
    }

    const workflow = await loadWorkflowSpecByNameOrPath(cwd, selector, action === 'run' ? runArgs ?? '' : '')
    if (action === 'show') {
      return {
        data: [
          `Workflow: ${workflow.commandName}`,
          `Name: ${workflow.plan.name}`,
          `Description: ${workflow.plan.description}`,
          `Source: ${workflow.path}`,
          `Max concurrency: ${workflow.plan.defaults.maxConcurrency}`,
          `Max agents: ${workflow.plan.defaults.maxAgents}`,
          `Planned agents: ${workflow.plan.totalAgents}`,
          `Phases: ${workflow.plan.phases.map(phase => phase.id).join(' -> ')}`,
        ].join('\n'),
      }
    }

    if (action === 'run') {
      // Use script runtime for script-based workflows
      if (workflow.spec.runScriptSnapshot && hasWorkflowScriptMeta(workflow.spec.runScriptSnapshot)) {
        return {
          data: await runWorkflowScript({
            script: workflow.spec.runScriptSnapshot,
            plan: workflow.plan,
            args: runArgs,
            context,
            canUseTool,
            assistantMessage,
            scriptPath: workflow.path,
          }),
        }
      }
      return {
        data: await runWorkflowPlan({
          plan: workflow.plan,
          context,
          canUseTool,
          assistantMessage,
          runArgs,
          injectRunArgsIntoRootPrompt: !workflow.spec.runScriptSnapshot,
        }),
      }
    }

    return { data: formatWorkflowDryRun(workflow.plan) }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
