import figures from 'figures'

import {
  WORKFLOW_SIZE_AGENT_LIMITS,
  type WorkflowSizeGuideline,
} from '../../tools/WorkflowTool/workflowFeatureFlags.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { LocalWorkflowTaskState } from './LocalWorkflowTask.js'

// Like official 2.1.303: a running workflow that schedules more agents than the cap, or has
// spent (or is projected to spend) more tokens than the cap, is flagged in the task rows.
export const WORKFLOW_SIZE_WARNING_AGENTS = 25
export const WORKFLOW_SIZE_WARNING_TOKENS = 1_500_000
export const WORKFLOW_SIZE_WARNING_ASSUMED_AGENT_TOKENS = 70_000
export const WORKFLOW_SIZE_WARNING_TEXT = `${figures.warning} Large workflow · /workflows to stop`
export const WORKFLOW_SIZE_WARNING_SHORT_TEXT = `${figures.warning} Large workflow`

export type WorkflowSizeWarning = {
  axis: 'agents' | 'tokens' | 'both'
  scheduledAgents: number
  totalTokens: number
  projectedTokens: number
  agentCap: number
  tokenCap: number
  capFromGuideline: boolean
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? undefined : positiveNumber(Number(raw))
}

export function workflowSizeWarning({
  scheduledAgents,
  startedAgents,
  totalTokens,
  ultracodeActive,
  guideline,
}: {
  scheduledAgents: number
  startedAgents: number
  totalTokens: number
  ultracodeActive: boolean
  guideline: WorkflowSizeGuideline | undefined
}): WorkflowSizeWarning | undefined {
  if (ultracodeActive) return undefined
  const guidelineCap =
    guideline === 'small' || guideline === 'medium' || guideline === 'large'
      ? WORKFLOW_SIZE_AGENT_LIMITS[guideline]
      : undefined
  const envAgentCap = positiveEnv('CLAUDE_CODE_WORKFLOW_SIZE_WARNING_AGENTS')
  const agentCap = envAgentCap ?? guidelineCap ?? WORKFLOW_SIZE_WARNING_AGENTS
  const tokenCap = positiveEnv('CLAUDE_CODE_WORKFLOW_SIZE_WARNING_TOKENS') ?? WORKFLOW_SIZE_WARNING_TOKENS
  const tokensPerAgent = startedAgents > 0 ? totalTokens / startedAgents : WORKFLOW_SIZE_WARNING_ASSUMED_AGENT_TOKENS
  const projectedTokens = Math.max(totalTokens, Math.round(tokensPerAgent * scheduledAgents))
  const overAgents = scheduledAgents > agentCap
  const overTokens = totalTokens > tokenCap || projectedTokens > tokenCap
  if (!overAgents && !overTokens) return undefined
  return {
    axis: overAgents && overTokens ? 'both' : overAgents ? 'agents' : 'tokens',
    scheduledAgents,
    totalTokens,
    projectedTokens,
    agentCap,
    tokenCap,
    capFromGuideline: overAgents && envAgentCap === undefined && guidelineCap !== undefined,
  }
}

const warnedTaskIds = new Set<string>()

export function workflowTaskSizeWarning(
  task: LocalWorkflowTaskState,
  ultracodeActive: boolean,
): WorkflowSizeWarning | undefined {
  if (task.status !== 'running') return undefined
  const warning = workflowSizeWarning({
    scheduledAgents: task.agentCount ?? task.phases.reduce((sum, phase) => sum + phase.agentIds.length, 0),
    startedAgents: task.startedAgentAttempts ?? 0,
    totalTokens: task.tokenCount ?? 0,
    ultracodeActive,
    guideline: getInitialSettings().workflowSizeGuideline ?? getGlobalConfig().workflowSizeGuideline,
  })
  if (warning && !warnedTaskIds.has(task.id)) {
    warnedTaskIds.add(task.id)
    logForDebugging(
      `workflow size warning shown for ${task.id}: axis=${warning.axis} scheduled_agents=${warning.scheduledAgents} total_tokens=${warning.totalTokens} projected_tokens=${warning.projectedTokens} agent_cap=${warning.agentCap} token_cap=${warning.tokenCap} cap_from_guideline=${warning.capFromGuideline}`,
    )
  }
  return warning
}
