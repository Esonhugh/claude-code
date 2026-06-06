import type { PermissionUpdate } from '../../types/permissions.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { formatWorkflowPermissionPreview } from './workflowPermissionPreview.js'

type WorkflowPermissionPhaseInput = {
  id?: string
  title?: string
  description?: string
  detail?: string
  prompt?: string
  fanout?: number
}

type WorkflowPermissionPlanInput = {
  name?: string
  description?: string
  phases?: WorkflowPermissionPhaseInput[]
  runScriptSnapshot?: string
}

export type WorkflowPermissionToolInput = {
  action?: string
  name?: string
  selector?: string
  runArgs?: unknown
  args?: unknown
  script?: string
  scriptPath?: string
  plan?: WorkflowPermissionPlanInput
}

export type WorkflowPermissionSelection =
  | 'yes'
  | 'yes-always'
  | 'view-raw'
  | 'no'

export type WorkflowPermissionSelectionResult =
  | {
      behavior: 'allow'
      updatedInput: WorkflowPermissionToolInput
      permissionUpdates: PermissionUpdate[]
      feedback?: string
    }
  | { behavior: 'reject'; feedback?: string }
  | { behavior: 'view-raw'; script: string }

export type WorkflowPermissionPreviewModel = {
  workflowName: string
  description: string
  args?: unknown
  phases: Array<{
    title: string
    detail?: string
    prompts: string[]
  }>
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function workflowNameFromToolInput(
  input: WorkflowPermissionToolInput,
): string {
  return input.plan?.name ?? input.name ?? input.selector ?? input.scriptPath ?? 'workflow'
}

export function workflowScriptFromToolInput(
  input: WorkflowPermissionToolInput,
): string {
  return input.script ?? input.plan?.runScriptSnapshot ?? ''
}

export function workflowInputWithEditedScript(
  input: WorkflowPermissionToolInput,
  script: string,
): WorkflowPermissionToolInput {
  return {
    ...input,
    script,
    ...(input.plan
      ? {
          plan: {
            ...input.plan,
            runScriptSnapshot: script,
          },
        }
      : {}),
  }
}

export function workflowPermissionInitialInput(
  input: WorkflowPermissionToolInput,
  updatedInput?: WorkflowPermissionToolInput,
): WorkflowPermissionToolInput {
  return updatedInput ?? input
}

export function workflowPermissionPreviewModelFromToolInput(
  input: WorkflowPermissionToolInput,
): WorkflowPermissionPreviewModel {
  return {
    workflowName: workflowNameFromToolInput(input),
    description: input.plan?.description ?? 'Dynamic workflow',
    args: input.runArgs ?? input.args,
    phases: (input.plan?.phases ?? []).map(phase => ({
      title: phase.title ?? titleCase(phase.id ?? 'phase'),
      detail: phase.detail ?? phase.description,
      prompts: phase.prompt ? [phase.prompt] : [],
    })),
  }
}

export function workflowPermissionPreviewFromToolInput(
  input: WorkflowPermissionToolInput,
  cwd: string,
): string {
  const preview = workflowPermissionPreviewModelFromToolInput(input)
  return formatWorkflowPermissionPreview({
    workflowName: preview.workflowName,
    description: preview.description,
    args: preview.args,
    cwd,
    phases: preview.phases,
  })
}

export function mapWorkflowPermissionSelectionToResult(
  selection: WorkflowPermissionSelection,
  input: WorkflowPermissionToolInput,
  cwd: string,
  feedback?: string,
): WorkflowPermissionSelectionResult {
  switch (selection) {
    case 'yes':
      return {
        behavior: 'allow',
        updatedInput: input,
        permissionUpdates: [],
        ...(feedback ? { feedback } : {}),
      }
    case 'yes-always':
      return {
        behavior: 'allow',
        updatedInput: input,
        permissionUpdates: [
          {
            type: 'addRules',
            rules: [
              {
                toolName: WORKFLOW_TOOL_NAME,
                ruleContent: `${workflowNameFromToolInput(input)}:${cwd}`,
              },
            ],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
        ...(feedback ? { feedback } : {}),
      }
    case 'view-raw':
      return {
        behavior: 'view-raw',
        script: workflowScriptFromToolInput(input),
      }
    case 'no':
      return {
        behavior: 'reject',
        ...(feedback ? { feedback } : {}),
      }
  }
}
