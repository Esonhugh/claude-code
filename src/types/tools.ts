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

export type SdkWorkflowProgress = {
  type: string
  index?: number
  phaseIndex?: number
  label?: string
  status?: string
  message?: string
}

export type ToolProgressData =
  | AgentToolProgress
  | BashProgress
  | MCPProgress
  | REPLToolProgress
  | SkillToolProgress
  | TaskOutputProgress
  | WebSearchProgress
  | PowerShellProgress
