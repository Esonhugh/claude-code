import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getCwd } from '../../utils/cwd.js'
import type { WorkflowArgs, WorkflowDryRunPlan } from './workflowSpec.js'
import { loadWorkflowScriptSpec } from './workflowDsl.js'
import { loadWorkflowSpecByNameOrPath } from './workflowDiscovery.js'
import { validateWorkflowSpec } from './validateWorkflowSpec.js'
import { runWorkflowPlan } from './runWorkflow.js'
import { runWorkflowScript } from './workflowScriptRuntime.js'
import { workflowPermissionPreviewInput } from './workflowPermissionPreviewInput.js'
import {
  createWorkflowRunId,
  persistWorkflowScript,
  resolveWorkflowScriptPath,
} from './workflowScriptPersistence.js'

export type WorkflowFacadeInput =
  | string
  | {
      name?: string
      script?: string
      scriptPath?: string
      args?: WorkflowArgs
      resumeFromRunId?: string
    }

export type NormalizedWorkflowFacadeInput =
  | {
      kind: 'saved-workflow'
      selector: string
      args?: WorkflowArgs
    }
  | {
      kind: 'inline-script'
      name: string
      script: string
      args?: WorkflowArgs
      resumeFromRunId?: string
    }
  | {
      kind: 'script-path'
      scriptPath: string
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
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.string())
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type WorkflowFacadeToolContext = {
  getCwd?: () => string
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
    return { kind: 'saved-workflow', selector, args: undefined }
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

  if (typeof input.script === 'string') {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new Error('Workflow script input requires a name')
    }
    return {
      kind: 'inline-script',
      name: input.name.trim(),
      script: input.script,
      args: input.args,
      resumeFromRunId: input.resumeFromRunId,
    }
  }

  if (typeof input.name === 'string' && input.name.trim() !== '') {
    return { kind: 'saved-workflow', selector: input.name.trim(), args: input.args }
  }

  throw new Error('Workflow input requires name, script, or scriptPath')
}

export const WorkflowFacadeTool = buildTool({
  name: 'Workflow',
  searchHint: 'run workflow scripts',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Run an official-compatible workflow script or saved workflow'
  },
  async prompt() {
    return `Use this tool to run dynamic workflows. It accepts a saved workflow name, { script, name }, or { scriptPath }. Workflow scripts orchestrate agents and must not directly perform shell or filesystem work.`
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
    const previewInput =
      normalized.kind === 'saved-workflow'
        ? { name: normalized.selector, args: normalized.args }
        : normalized.kind === 'script-path'
          ? {
              scriptPath: normalized.scriptPath,
              args: normalized.args,
              ...(normalized.resumeFromRunId
                ? { resumeFromRunId: normalized.resumeFromRunId }
                : {}),
            }
          : {
              name: normalized.name,
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
    return `Workflow ${normalized.name}`
  },
  async call(input, context, canUseTool, assistantMessage) {
    const cwd = resolveCwd(context)
    const normalized = normalizeWorkflowFacadeInput(input as WorkflowFacadeInput)

    if (normalized.kind === 'saved-workflow') {
      const workflow = await loadWorkflowSpecByNameOrPath(
        cwd,
        normalized.selector,
        normalized.args,
      )
      // Use script runtime for script-based workflows
      if (workflow.spec.runScriptSnapshot && workflow.spec.runtime?.kind === 'javascript-worker') {
        return {
          data: await runWorkflowScript({
            script: workflow.spec.runScriptSnapshot,
            plan: workflow.plan,
            args: normalized.args,
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
          runArgs: normalized.args,
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
            name: normalized.name,
            script: normalized.script,
          })
    const spec = await loadWorkflowScriptSpec(scriptPath, normalized.args)
    const plan = validateWorkflowSpec(spec) as WorkflowDryRunPlan
    // Use script runtime for script-based workflows
    if (spec.runScriptSnapshot && spec.runtime?.kind === 'javascript-worker') {
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
