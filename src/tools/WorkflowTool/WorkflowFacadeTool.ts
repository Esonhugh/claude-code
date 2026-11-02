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
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { renderToolResultMessage } from './UI.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { WORKFLOW_AUTHORING_SKILL_NAME } from '../../skills/bundled/workflowAuthoring.js'

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

function workflowScriptLabel(script: string): string {
  if (hasWorkflowScriptMeta(script)) {
    try {
      return parseWorkflowScript(script).meta.description
    } catch {
      // Unparsable meta: label the call with its first line below.
    }
  }
  const firstLine = script.split('\n').find(line => line.trim())?.trim() ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine
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
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'orchestrate subagents with deterministic JavaScript workflow',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Run an official-compatible workflow script or saved workflow'
  },
  async prompt() {
    return `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** in the workflow authoring reference.
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call Workflow.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use the ${AGENT_TOOL_NAME} tool (if available) for individual subagents, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.

Every script must begin with \`export const meta = {...}\`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's \`name\`, a one-line \`description\` (shown in the permission dialog) and optionally \`phases\` — one \`{ title, detail? }\` per phase() call, titles matched exactly. Pass the script inline via \`script\` — do not Write it to a file first, and do not also set the tool's \`name\` input (that selects a saved workflow); it is plain JavaScript, not TypeScript.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
  return { confirmed }
  // Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.

Before writing a script, load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\` skill — the workflow authoring reference: script API and gotchas, resume, the **Ultracode** section, quality patterns, worked examples.${workflowSizeGuidelinePrompt(getInitialSettings(), getGlobalConfig().workflowSizeGuideline)}`
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
  // Official 2.1.311 labels: the script's meta description, or
  // "dynamic workflow: <name>" for a saved one.
  renderToolUseMessage(input) {
    const normalized = normalizeWorkflowFacadeInput(input as WorkflowFacadeInput)
    if (normalized.kind === 'plan') return 'plan'
    const script = 'script' in normalized ? normalized.script : undefined
    const label =
      normalized.kind === 'saved-workflow'
        ? `dynamic workflow: ${normalized.selector}`
        : normalized.kind === 'script-path'
          ? normalized.scriptPath
          : undefined
    if (!script) return label ?? ''
    return label ? `${label} · ${workflowScriptLabel(script)}` : workflowScriptLabel(script)
  },
  renderToolResultMessage,
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
