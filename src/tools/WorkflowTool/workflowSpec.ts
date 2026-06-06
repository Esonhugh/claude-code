import type { WorkflowScriptMeta } from './workflowScriptParser.js'

export type WorkflowReviewMode = 'none' | 'cross-check' | 'adversarial' | 'synthesis'

export type WorkflowPermissionMode = 'default' | 'acceptEdits' | 'plan'

export type WorkflowArgs =
  | string
  | number
  | boolean
  | null
  | WorkflowArgs[]
  | { [key: string]: WorkflowArgs }

export type WorkflowInputSpec = {
  name: string
  description?: string
  required?: boolean
  default?: unknown
}

export type WorkflowDefaults = {
  maxConcurrency?: number
  maxAgents?: number
  maxRetries?: number
  fanout?: number
  concurrency?: number
  review?: WorkflowReviewMode
  permissionMode?: WorkflowPermissionMode
  agentType?: string
  model?: string
  execution?: 'agent' | 'team'
}

export type WorkflowPhaseSpec = {
  id: string
  description: string
  prompt: string
  dependsOn?: string[]
  fanout?: number
  concurrency?: number
  review?: WorkflowReviewMode
  permissionMode?: WorkflowPermissionMode
  agentType?: string
  model?: string
}

export type WorkflowOutputSpec = {
  format?: string
  description?: string
}

export type WorkflowRuntimeSpec = {
  kind: 'declarative' | 'javascript-worker'
  sourcePath?: string
  isolated?: boolean
}

export type WorkflowProgressEvent =
  | {
      type: 'workflow_progress'
      workflowRunId: string
      status: 'running' | 'paused' | 'completed' | 'failed' | 'killed'
      completedAgents: number
      totalAgents: number
      timestamp: number
    }
  | {
      type: 'workflow_phase'
      workflowRunId: string
      phaseId: string
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
      timestamp: number
    }
  | {
      type: 'workflow_agent'
      workflowRunId: string
      phaseId: string
      agentId: string
      status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
      cacheHit?: boolean
      timestamp: number
    }
  | {
      type: 'workflow_log'
      workflowRunId: string
      message: string
      timestamp: number
    }

export type WorkflowSpec = {
  name: string
  description: string
  inputs?: WorkflowInputSpec[]
  defaults?: WorkflowDefaults
  phases: WorkflowPhaseSpec[]
  output?: WorkflowOutputSpec
  runtime?: WorkflowRuntimeSpec
  sourcePath?: string
  runScriptSnapshot?: string
  meta?: WorkflowScriptMeta
  scriptResult?: unknown
}

export type WorkflowDryRunPhase = {
  id: string
  description: string
  prompt: string
  dependsOn: string[]
  fanout: number
  concurrency: number
  review: WorkflowReviewMode
  permissionMode: WorkflowPermissionMode
  agentType?: string
  model?: string
}

export type WorkflowDryRunPlan = {
  name: string
  description: string
  defaults: Required<Pick<WorkflowDefaults, 'maxConcurrency' | 'maxAgents' | 'maxRetries' | 'fanout' | 'concurrency' | 'review' | 'permissionMode' | 'execution'>> & Pick<WorkflowDefaults, 'agentType' | 'model'>
  phases: WorkflowDryRunPhase[]
  totalAgents: number
  output?: WorkflowOutputSpec
  runtime?: WorkflowRuntimeSpec
  sourcePath?: string
  runScriptSnapshot?: string
  meta?: WorkflowScriptMeta
  scriptResult?: unknown
}
