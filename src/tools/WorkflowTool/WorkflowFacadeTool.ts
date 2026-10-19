import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { getGlobalConfig } from '../../utils/config.js'
import type { WorkflowArgs, WorkflowDryRunPlan, WorkflowSpec } from './workflowSpec.js'
import { loadWorkflowScriptSpec, preflightWorkflowScript } from './workflowDsl.js'
import { loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'
import { hasWorkflowScriptMeta, parseWorkflowScript } from './workflowScriptParser.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'
import { runWorkflowPlan } from './runWorkflow.js'
import { loadWorkflowScriptResume, runWorkflowScript } from './workflowScriptRuntime.js'
import { workflowPermissionPreviewInput } from './workflowPermissionPreviewInput.js'
import {
  createWorkflowRunId,
  persistWorkflowScript,
  resolveWorkflowScriptPath,
} from './workflowScriptPersistence.js'
import { shouldEnableWorkflows, workflowSizeGuidelinePrompt } from './workflowFeatureFlags.js'

export type WorkflowFacadeInput =
  | string
  | {
      name?: string
      script?: string
      scriptPath?: string
      args?: WorkflowArgs
      resumeFromRunId?: string
      plan?: unknown
      description?: string
      title?: string
    }

export type NormalizedWorkflowFacadeInput =
  | {
      kind: 'saved-workflow'
      selector: string
      script?: string
      args?: WorkflowArgs
      resumeFromRunId?: string
    }
  | {
      kind: 'inline-script'
      script: string
      args?: WorkflowArgs
      resumeFromRunId?: string
    }
  | {
      kind: 'script-path'
      scriptPath: string
      script?: string
      args?: WorkflowArgs
      resumeFromRunId?: string
    }
  | {
      kind: 'plan'
      plan: unknown
      args?: WorkflowArgs
      resumeFromRunId?: string
    }

const workflowArgsSchema: z.ZodType<WorkflowArgs> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(workflowArgsSchema),
    z.record(z.string(), workflowArgsSchema),
  ]),
)

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z.string().optional(),
    script: z.string().optional(),
    scriptPath: z.string().optional(),
    args: workflowArgsSchema.optional(),
    resumeFromRunId: z.string().regex(/^wf_[a-z0-9-]{6,}$/).optional(),
    plan: z.unknown().optional(),
    description: z.string().optional(),
    title: z.string().optional(),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.string())
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type WorkflowFacadeToolContext = {
  getCwd?: () => string
}

function normalizeWorkflowRunArgs(args: WorkflowArgs | undefined): string {
  if (args === undefined || args === null) return ''
  return typeof args === 'string' ? args.trim() : JSON.stringify(args).trim()
}

function isExecutableWorkflowScript(workflow: WorkflowSpec): boolean {
  return Boolean(workflow.runScriptSnapshot && hasWorkflowScriptMeta(workflow.runScriptSnapshot))
}

function shouldInjectRunArgsIntoRootPrompt(workflow: WorkflowSpec, sourcePath: string): boolean {
  return !workflow.runScriptSnapshot || (sourcePath.startsWith('bundled:') && !isExecutableWorkflowScript(workflow))
}

function inlineWorkflowName(script: string): string | undefined {
  return hasWorkflowScriptMeta(script)
    ? parseWorkflowScript(script).meta.name
    : undefined
}

function resolveCwd(context: WorkflowFacadeToolContext | unknown): string {
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

export function normalizeWorkflowFacadeInput(
  input: WorkflowFacadeInput,
): NormalizedWorkflowFacadeInput {
  if (typeof input === 'string') {
    const selector = input.trim()
    if (!selector) throw new Error('Workflow name is required')
    return { kind: 'saved-workflow', selector, args: undefined, resumeFromRunId: undefined }
  }

  if (typeof input !== 'object' || input === null) {
    throw new Error('Workflow input must be a workflow name or an object')
  }

  if (typeof input.scriptPath === 'string' && input.scriptPath !== '') {
    return {
      kind: 'script-path',
      scriptPath: input.scriptPath,
      args: input.args,
      resumeFromRunId: input.resumeFromRunId,
    }
  }

  if (typeof input.name === 'string' && input.name.trim() !== '') {
    return {
      kind: 'saved-workflow',
      selector: input.name.trim(),
      ...(input.script !== undefined ? { script: input.script } : {}),
      args: input.args,
      resumeFromRunId: input.resumeFromRunId,
    }
  }

  if (typeof input.script === 'string') {
    return {
      kind: 'inline-script',
      script: input.script,
      args: input.args,
      resumeFromRunId: input.resumeFromRunId,
    }
  }

  if ('plan' in input && input.plan !== undefined) {
    return { kind: 'plan', plan: input.plan, args: input.args, resumeFromRunId: input.resumeFromRunId }
  }

  throw new Error('Workflow input requires name, script, scriptPath, or plan')
}

export const WorkflowFacadeTool = buildTool({
  name: 'Workflow',
  searchHint: 'run workflow scripts',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return 'Run an official-compatible workflow script or saved workflow'
  },
  async prompt() {
    return `Use this tool to run dynamic workflows. It accepts a saved workflow name, { script }, { scriptPath }, or { plan }. Workflow scripts orchestrate agents and must not directly perform shell or filesystem work.

Pass the script inline via \`script\`; do not write it to a file first. The script's \`meta.name\` is the workflow's runtime name. Top-level \`name\` selects a saved workflow, and \`scriptPath\` takes precedence over both \`name\` and \`script\`.

Inline official-style scripts must start with an uncommented \`export const meta = { name, description, phases }\` as the first statement. Phase entries must be objects with a string \`title\`, for example:

\`\`\`js
export const meta = {
  name: 'parallel-review',
  description: 'Review two areas concurrently.',
  phases: [{ title: 'Review' }],
}
phase('Review')
const reports = await parallel([
  () => agent('Review area A'),
  () => agent('Review area B'),
])
return reports
\`\`\`

Do not comment out the meta export. Without it, the script is treated as the legacy workflow DSL, where official-style globals and top-level await/return semantics do not apply.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it).
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the Agent tool (if available) for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask. If the user asks to avoid workflow orchestration, do not call this tool.${workflowSizeGuidelinePrompt(getInitialSettings(), getGlobalConfig().workflowSizeGuideline)}`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return shouldEnableWorkflows(getInitialSettings())
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  async checkPermissions(input, context) {
    const cwd = resolveCwd(context)
    const normalized = normalizeWorkflowFacadeInput(input as WorkflowFacadeInput)
    if (normalized.kind === 'saved-workflow' && normalized.script) {
      await loadWorkflowSpecByNameOrPath(cwd, normalized.selector, normalized.args)
    }
    const previewInput =
      normalized.kind === 'saved-workflow'
        ? {
            name: normalized.selector,
            ...(normalized.script !== undefined ? { script: normalized.script } : {}),
            args: normalized.args,
            ...(normalized.resumeFromRunId
              ? { resumeFromRunId: normalized.resumeFromRunId }
              : {}),
          }
        : normalized.kind === 'script-path'
          ? {
              scriptPath: normalized.scriptPath,
              args: normalized.args,
              ...(normalized.resumeFromRunId
                ? { resumeFromRunId: normalized.resumeFromRunId }
                : {}),
            }
          : normalized.kind === 'plan'
            ? {
                plan: normalized.plan,
                args: normalized.args,
                ...(normalized.resumeFromRunId
                  ? { resumeFromRunId: normalized.resumeFromRunId }
                  : {}),
              }
            : {
                script: normalized.script,
                args: normalized.args,
                ...(normalized.resumeFromRunId
                  ? { resumeFromRunId: normalized.resumeFromRunId }
                  : {}),
              }
    return {
      behavior: 'ask',
      message: 'Run a dynamic workflow?',
      updatedInput: await workflowPermissionPreviewInput(previewInput, cwd),
    }
  },
  renderToolUseMessage(input) {
    const normalized = normalizeWorkflowFacadeInput(input as WorkflowFacadeInput)
    if (normalized.kind === 'saved-workflow') return `Workflow ${normalized.selector}`
    if (normalized.kind === 'script-path') return `Workflow ${normalized.scriptPath}`
    if (normalized.kind === 'plan') return 'Workflow plan'
    return `Workflow ${inlineWorkflowName(normalized.script) ?? 'inline script'}`
  },
  async call(input, context, canUseTool, assistantMessage) {
    const cwd = resolveCwd(context)
    const normalized = normalizeWorkflowFacadeInput(input as WorkflowFacadeInput)

    if (normalized.kind === 'plan') {
      const plan = validateWorkflowSpec(normalized.plan as WorkflowSpec) as WorkflowDryRunPlan
      return {
        data: await runWorkflowPlan({
          plan,
          context,
          canUseTool,
          assistantMessage,
          runArgs: normalized.args,
          resumeFromRunId: normalized.resumeFromRunId,
        }),
      }
    }

    if (normalized.kind === 'saved-workflow') {
      const workflow = await loadWorkflowSpecByNameOrPath(
        cwd,
        normalized.selector,
        normalized.args,
      )
      const resumeScript = normalized.script ?? workflow.spec.runScriptSnapshot
      const resume = normalized.resumeFromRunId && resumeScript && hasWorkflowScriptMeta(resumeScript)
        ? await loadWorkflowScriptResume({ cwd, workflowRunId: normalized.resumeFromRunId, context })
        : undefined
      const workflowRunId = resume
        ? normalized.resumeFromRunId
        : normalized.script ? createWorkflowRunId() : undefined
      if (normalized.script && hasWorkflowScriptMeta(normalized.script)) {
        preflightWorkflowScript(normalized.script, 'workflow.js')
      }
      const scriptPath = normalized.script
        ? await persistWorkflowScript({
            cwd,
            workflowRunId: workflowRunId!,
            name: inlineWorkflowName(normalized.script) ?? workflow.commandName,
            script: normalized.script,
          })
        : workflow.path
      const spec = normalized.script
        ? await loadWorkflowScriptSpec(scriptPath, normalized.args)
        : workflow.spec
      const plan = normalized.script
        ? validateWorkflowSpec(spec) as WorkflowDryRunPlan
        : workflow.plan
      if (plan.requiresInput && !normalizeWorkflowRunArgs(normalized.args)) {
        throw new Error(`Workflow ${workflow.commandName} requires workflow input`)
      }
      // Use script runtime for script-based workflows
      if (isExecutableWorkflowScript(spec)) {
        return {
          data: await runWorkflowScript({
            script: spec.runScriptSnapshot!,
            plan,
            args: normalized.args,
            context,
            canUseTool,
            assistantMessage,
            workflowRunId,
            scriptPath,
            resumeFromRunId: normalized.resumeFromRunId,
            resumeJournalEntries: resume?.entries,
            resumeInterruptedIdentities: resume?.interruptedIdentities,
          }),
        }
      }
      return {
        data: await runWorkflowPlan({
          plan,
          context,
          canUseTool,
          assistantMessage,
          runArgs: normalized.args,
          workflowRunId,
          scriptPath,
          resumeFromRunId: normalized.resumeFromRunId,
          injectRunArgsIntoRootPrompt: shouldInjectRunArgsIntoRootPrompt(spec, scriptPath),
        }),
      }
    }

    // Checked before the script is persisted, so a refused resume leaves nothing behind.
    const resume = normalized.resumeFromRunId &&
      (normalized.kind === 'script-path' || hasWorkflowScriptMeta(normalized.script))
      ? await loadWorkflowScriptResume({ cwd, workflowRunId: normalized.resumeFromRunId, context })
      : undefined
    const workflowRunId = resume ? normalized.resumeFromRunId! : createWorkflowRunId()
    // Compile an inline meta script before persisting it, so a syntax error leaves no file behind.
    if (normalized.kind !== 'script-path' && hasWorkflowScriptMeta(normalized.script)) {
      preflightWorkflowScript(normalized.script, 'workflow.js')
    }
    const scriptPath =
      normalized.kind === 'script-path'
        ? await resolveWorkflowScriptPath({ cwd, scriptPath: normalized.scriptPath })
        : await persistWorkflowScript({
            cwd,
            workflowRunId,
            name: inlineWorkflowName(normalized.script) ?? 'workflow',
            script: normalized.script,
          })
    const spec = await loadWorkflowScriptSpec(scriptPath, normalized.args)
    const plan = validateWorkflowSpec(spec) as WorkflowDryRunPlan
    // Use script runtime for script-based workflows
    if (spec.runScriptSnapshot && hasWorkflowScriptMeta(spec.runScriptSnapshot)) {
      return {
        data: await runWorkflowScript({
          script: spec.runScriptSnapshot,
          plan,
          args: normalized.args,
          context,
          canUseTool,
          assistantMessage,
          workflowRunId,
          scriptPath,
          resumeFromRunId: normalized.resumeFromRunId,
          resumeJournalEntries: resume?.entries,
          resumeInterruptedIdentities: resume?.interruptedIdentities,
        }),
      }
    }
    return {
      data: await runWorkflowPlan({
        plan,
        context,
        canUseTool,
        assistantMessage,
        runArgs: normalized.args,
        workflowRunId,
        scriptPath,
        resumeFromRunId: normalized.resumeFromRunId,
        injectRunArgsIntoRootPrompt: shouldInjectRunArgsIntoRootPrompt(spec, scriptPath),
      }),
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
