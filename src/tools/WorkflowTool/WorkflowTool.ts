import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import {
  formatWorkflowResumeInstruction,
  formatWorkflowStatus,
} from '../../tasks/LocalWorkflowTask/formatWorkflowStatus.js'
import {
  pauseWorkflowTask,
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

const WORKFLOW_TOOL_PROMPT = `Use this tool to inspect or execute validated dynamic workflow specs. Workflows orchestrate multiple subagents deterministically through phase-grouped execution, recording LocalWorkflowTask state. The tool does not directly perform shell or filesystem work — agents launched by the workflow do, under normal tool permissions and hooks.

## Actions

- list: discover saved workflow specs from docs/workflows or .claude/workflows.
- show <selector>: inspect a workflow's metadata (name, description, source, phases, concurrency).
- dry-run <selector>: preview the planned phase graph and per-phase agent allocation without executing.
- run <selector> [runArgs]: execute a saved workflow. Bundled specs and persisted scripts both run through this action. Provide runArgs as a string (or omit when the workflow does not require input).
- run with plan: pass a validated dry-run plan via the plan parameter when the spec was produced locally and no selector is available.
- status <taskId>: inspect a running or completed LocalWorkflowTask.
- pause <taskId>: stop a running workflow and emit a resumeFromRunId prompt.
- resume <taskId>: print the resume prompt for a paused workflow.

Do not treat /workflows text arguments as the launcher. /workflows is display and management UI; this tool is the execution surface.

## Explicit opt-in requirement

Only execute action="run" when the user has explicitly opted into workflow-scale orchestration. Explicit opt-in includes:

- The user asks for a dynamic workflow, workflow, ultracode-style orchestration, multi-agent orchestration, fan-out, broad audit, migration, deep research, or cross-checking.
- The user asks to run a named or saved workflow.
- A loaded skill or command instruction explicitly tells you to call this tool.
- A system reminder says ultracode or dynamic workflow mode is active for the turn.

If a task merely could benefit from a workflow but the user did not opt in, do not silently run one. Use normal tools or briefly explain what a workflow would do and ask before running one.

## Ultracode

When ultracode is on for a turn (effort=ultracode or the ultracode keyword), optimize for the most exhaustive, correct answer, not the fastest or cheapest. Prefer WorkflowTool for broad, workflow-scale orchestration such as audits, migrations, deep research, cross-checking, or independent fan-out. For focused tasks, use direct tools or a small number of subagents. Do not run WorkflowTool when the user asks to avoid workflow orchestration. Solo-execute on conversational/trivial turns. See the quality patterns section for the verification techniques to lean on.

When ultracode is off, the standard opt-in rule above applies again.

## Workflow scripts

A workflow saved as a script must start with:

\`\`\`js
export const meta = { name, description, phases }
\`\`\`

The meta object must be a pure literal, matching the AST-parser expectations:

- Allowed values: string/number/boolean/null literals, arrays, plain objects, negative numeric literals, and template literals without expressions.
- Rejected values: variables, identifiers, function calls, spread, sparse arrays, computed keys, methods, accessors, template interpolation, TypeScript syntax, and reserved keys such as __proto__, constructor, and prototype.
- Required fields are non-empty string name and description.
- Use phases to preview progress groups; phase entries should use string title, and optional string detail/model.

The script body orchestrates agents with workflow runtime globals:

- agent(prompt, opts): spawn a subagent. Use agent({ schema }) when structured output is needed, and expect the subagent to return via the structured output tool rather than prose.
- pipeline(items, stage1, stage2, ...): run each item through all stages independently.
- parallel(thunks): run independent tasks concurrently and wait for all results. Pass thunks/functions, not promises.
- phase(title): group later agent calls under a progress phase.
- log(message): emit progress.
- args: user input passed to the workflow. Pass arrays/objects as real JSON values, not JSON-encoded strings.
- budget: token budget helper when available.
- workflow(nameOrRef, args): call a child workflow when available; avoid deep nesting.

Scripts orchestrate agents only — they must not directly perform shell or filesystem work. Scripts run in a constrained official-style JavaScript environment. Do not depend on Node filesystem or shell APIs, dynamic import, Date.now(), bare Date(), argless new Date(), Math.random(), eval, Function, WebAssembly, or deep child workflow nesting. Pass time, random seeds, and external data through args when needed.

## pipeline() vs parallel()

Default to pipeline() for multi-stage per-item work. It avoids unnecessary barriers because item A can advance while item B is still in an earlier stage.

Use parallel() as a barrier only when the next step genuinely needs all previous results together, such as deduping across all findings, comparing all candidates, or deciding whether the total count is zero.

parallel(thunks) expects an array of functions, not promises. Write () => agent(...) entries so the workflow runtime controls launch timing.

Failed branches or budget-limited branches can produce null results while preserving partial workflow progress. Synthesis stages must handle null or missing branch outputs.

Do not add a barrier just to flatten, map, filter, or make code look cleaner. Put simple transforms inside a pipeline stage.

## Loop and budget safety

Loop-until-dry patterns must include a hard cap such as max rounds or max new findings. budget.remaining() may be Infinity when no token budget is configured, so do not rely on it as the only loop bound.

## Quality patterns

Use these patterns when they fit the task:

- Adversarial verify: ask independent skeptics to refute each finding before accepting it.
- Perspective-diverse verify: use distinct lenses such as correctness, security, performance, and reproducibility.
- Judge panel: generate multiple independent approaches, score them, then synthesize the best parts.
- Loop-until-dry: keep discovering until consecutive rounds find nothing new, with an explicit hard cap.
- Multi-modal sweep: search by different modalities such as file structure, content, ownership, time, or runtime behavior.
- Completeness critic: run a final agent asking what evidence, modality, or verification is missing.
- No silent caps: if coverage is bounded or sampled, log what was skipped.

Scale to what the user asked for. A broad audit or migration deserves stronger fan-out and verification than a quick check.

## Resume and iteration

Workflow runs expose a workflowRunId and scriptPath in the LocalWorkflowTask state. To iterate on a persisted script, edit the file on disk and call action="run" with the same selector — the runtime resumes by selector and replays validation, permission previews, hooks, and progress reporting. Do not copy a dry-run plan from prompt text and execute it as a raw plan when a selector or scriptPath exists; reload by selector so task state, hooks, and resume semantics stay intact.

## Permission and execution boundaries

- Preserve normal tool permissions and hooks for child agents.
- Let workflow phases launch agents through the workflow runtime.
- Do not narrow child agents to the parent orchestration tool scope.
- Do not promote /workflow or /workflows run as user-facing command guidance.
- Do not manually perform phase work in the main thread.`


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

function normalizeWorkflowRunArgs(runArgs: unknown): string {
  if (runArgs === undefined || runArgs === null) return ''
  return typeof runArgs === 'string' ? runArgs.trim() : JSON.stringify(runArgs).trim()
}

function isExecutableWorkflowScript(workflow: WorkflowSpec): boolean {
  return Boolean(workflow.runScriptSnapshot && hasWorkflowScriptMeta(workflow.runScriptSnapshot))
}

function shouldInjectRunArgsIntoRootPrompt(workflow: WorkflowSpec, sourcePath: string): boolean {
  return !workflow.runScriptSnapshot || (sourcePath.startsWith('bundled:') && !isExecutableWorkflowScript(workflow))
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
  status: 'paused'
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
    return WORKFLOW_TOOL_PROMPT
  },
  async prompt() {
    return WORKFLOW_TOOL_PROMPT
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
    return !['run', 'pause'].includes(input.action)
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
      return {
        data: [
          formatWorkflowStatus(task),
          'Some notifications may still arrive after pause; they are part of this workflow run.',
        ].join('\n'),
      }
    }

    if (action === 'resume') {
      const task = loadWorkflowTask(context, selector)
      if (task.status !== 'pending') {
        return { data: formatWorkflowStatus(task) }
      }
      return { data: formatWorkflowResumeInstruction(task) }
    }

    const workflow = await loadWorkflowSpecByNameOrPath(cwd, selector, action === 'run' ? runArgs ?? '' : '')
    if (action === 'run' && workflow.plan.requiresInput && !normalizeWorkflowRunArgs(runArgs)) {
      throw new Error(`Workflow ${workflow.commandName} requires workflow input`)
    }
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
      if (isExecutableWorkflowScript(workflow.spec)) {
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
          injectRunArgsIntoRootPrompt: shouldInjectRunArgsIntoRootPrompt(workflow.spec, workflow.path),
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
