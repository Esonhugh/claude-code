import type { Message } from './message.js'

export type AgentToolProgress = {
  type: 'agent_progress'
  message: Message
  taskId?: string
  summary?: string
  prompt?: string
  agentId?: string
  agentType?: string
  description?: string
  resolvedModel?: string
}

export type ShellProgress = {
  type: 'shell_progress' | 'bash_progress' | 'powershell_progress'
  output: string
  fullOutput?: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  timeoutMs?: number
  taskId?: string
}

export type BashProgress = ShellProgress

export type PowerShellProgress = ShellProgress

export type MCPProgress = {
  type: 'mcp_progress'
  progress?: number
  total?: number
  progressMessage?: string
}

export type REPLToolProgress = {
  type: 'repl_progress'
  message?: string
}

/** One tool call made from inside a Code Mode REPL script. */
export type REPLToolCallProgress = {
  type: 'repl_tool_call'
  phase: 'start' | 'executing' | 'complete' | 'error'
  toolName: string
  toolUseId: string
}

export type SkillToolProgress = {
  type: 'skill_progress'
  message: Message
  summary?: string
}

export type TaskOutputProgress = {
  type: 'task_output_progress' | 'waiting_for_task'
  message?: string
  taskId?: string
  taskDescription?: string
  taskType?: string
}

export type WebSearchProgress =
  | {
      type: 'query_update'
      query: string
    }
  | {
      type: 'search_results_received'
      query: string
      resultCount: number
    }

// A workflow's progress rows as official 2.1.329 sends them in task_progress
// `workflow_progress`: one per agent() call and one per phase, keyed by index.
export type SdkWorkflowAgentProgress = {
  type: 'workflow_agent'
  index: number
  label: string
  phaseIndex?: number
  phaseTitle?: string
  agentId?: string
  agentType?: string
  isolation?: string
  model?: string
  fallbackModel?: string
  state: 'start' | 'progress' | 'done' | 'error'
  startedAt?: number
  queuedAt?: number
  attempt?: number
  lastAttemptReason?: string
  lastToolName?: string
  lastToolSummary?: string
  promptPreview?: string
  promptFramed?: boolean
  lastProgressAt?: number
  tokens?: number
  toolCalls?: number
  durationMs?: number
  resultPreview?: string
  error?: string
  endedWithRun?: string
  skipped?: boolean
  blocked?: boolean
  cached?: boolean
}

export type SdkWorkflowPhaseProgress = {
  type: 'workflow_phase'
  index: number
  title: string
  kind?: string
}

export type SdkWorkflowProgress = SdkWorkflowAgentProgress | SdkWorkflowPhaseProgress

export type ToolProgressData =
  | AgentToolProgress
  | BashProgress
  | MCPProgress
  | REPLToolProgress
  | REPLToolCallProgress
  | SkillToolProgress
  | TaskOutputProgress
  | WebSearchProgress
  | PowerShellProgress
