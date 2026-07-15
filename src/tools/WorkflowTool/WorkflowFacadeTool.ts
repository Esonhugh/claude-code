import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import type { WorkflowArgs, WorkflowDryRunPlan, WorkflowSpec } from './workflowSpec.js'
import { loadWorkflowScriptSpec } from './workflowDsl.js'
import { loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'
import { hasWorkflowScriptMeta, parseWorkflowScript } from './workflowScriptParser.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'
import { runWorkflowPlan } from './runWorkflow.js'
import { runWorkflowScript } from './workflowScriptRuntime.js'
import { workflowPermissionPreviewInput } from './workflowPermissionPreviewInput.js'
import {
  createWorkflowRunId,
  persistWorkflowScript,
  resolveWorkflowScriptPath,
} from './workflowScriptPersistence.js'
import { loadWorkflowRunSession } from './workflowRunSessions.js'
import { readWorkflowJournalCacheEntries } from './workflowJournal.js'

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
    resumeFromRunId: z.string().optional(),
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

  if (typeof input.scriptPath === 'string') {
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

Use this facade only for workflow-scale orchestration or when the user explicitly asks to run a workflow/script/plan. For focused tasks, use direct tools or a small number of subagents instead. If the user asks to avoid workflow orchestration, do not call this tool.`
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
      const workflowRunId = normalized.script ? createWorkflowRunId() : undefined
      const scriptPath = normalized.script
        ? await persistWorkflowScript({
            cwd,
            workflowRunId: workflowRunId!,
            name: inlineWorkflowName(normalized.script) ?? workflow.commandName,
            script: normalized.script,
          })
        : workflow.path
      const spec = normalized.script
        ? await loadWorkflowScriptSpec(scriptPath, normalized.args, { cwd })
        : workflow.spec
      const plan = normalized.script
        ? validateWorkflowSpec(spec) as WorkflowDryRunPlan
        : workflow.plan
      if (plan.requiresInput && !normalizeWorkflowRunArgs(normalized.args)) {
        throw new Error(`Workflow ${workflow.commandName} requires workflow input`)
      }
      const priorSession = normalized.resumeFromRunId
        ? await loadWorkflowRunSession({ cwd, workflowRunId: normalized.resumeFromRunId })
        : undefined
      const resumeJournalEntries = priorSession?.transcriptDir
        ? await readWorkflowJournalCacheEntries(priorSession.transcriptDir)
        : priorSession?.resumeCacheEntries
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
            resumeJournalEntries,
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

    const workflowRunId = createWorkflowRunId()
    const scriptPath =
      normalized.kind === 'script-path'
        ? await resolveWorkflowScriptPath({ cwd, scriptPath: normalized.scriptPath })
        : await persistWorkflowScript({
            cwd,
            workflowRunId,
            name: inlineWorkflowName(normalized.script) ?? 'workflow',
            script: normalized.script,
          })
    const spec = await loadWorkflowScriptSpec(scriptPath, normalized.args, { cwd })
    const plan = validateWorkflowSpec(spec) as WorkflowDryRunPlan
    const priorSession = normalized.resumeFromRunId
      ? await loadWorkflowRunSession({ cwd, workflowRunId: normalized.resumeFromRunId })
      : undefined
    const resumeJournalEntries = priorSession?.transcriptDir
      ? await readWorkflowJournalCacheEntries(priorSession.transcriptDir)
      : priorSession?.resumeCacheEntries
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
          resumeJournalEntries,
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
