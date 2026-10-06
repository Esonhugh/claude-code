import type { ToolUseContext } from '../Tool.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isWorkflowScriptsFeatureEnabled, shouldEnableWorkflows } from '../tools/WorkflowTool/workflowFeatureFlags.js'
import { logForDebugging } from './debug.js'
import { modelSupportsXHighEffort } from './effort.js'

export class AgentPreconditionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentPreconditionError'
  }
}

export function getMaxConcurrentSubagents(): number {
  const raw = process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS?.trim() ?? ''
  const parsed = Number(raw)
  return /^[+-]?\d+$/.test(raw) && Number.isFinite(parsed) && parsed >= 1 ? parsed : 20
}

export function assertSubagentCapacity(context: ToolUseContext): void {
  const state = (context.getAppStateForTasks ?? context.getAppState)()
  const running = state.runningSubagents ?? 0
  const limit = getMaxConcurrentSubagents()
  if (running < limit) return
  if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_kestrel', false)) return
  if (state.effortValue === 'ultracode' && isWorkflowScriptsFeatureEnabled() &&
      shouldEnableWorkflows(state.settings) && modelSupportsXHighEffort(context.options.mainLoopModel)) return
  logForDebugging('Agent concurrent limit reached: running=' + running + ' limit=' + limit)
  throw new AgentPreconditionError('Concurrent subagent limit reached. You can run ' + limit + ' subagents at once. Do not retry. If the user wants more concurrent subagents, ask them to increase CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.')
}

// Slots belong to executions, including resumed/forked runs without a new-launch guard.
export function takeSubagentConcurrencySlot(context: ToolUseContext): () => void {
  const setState = context.setAppStateForTasks ?? context.setAppState
  setState(prev => {
    const runningSubagents = (prev.runningSubagents ?? 0) + 1
    logForDebugging('[AgentConcurrency] reserved running=' + runningSubagents)
    return { ...prev, runningSubagents }
  })
  let released = false
  return () => {
    if (released) return
    released = true
    setState(prev => {
      const runningSubagents = Math.max(0, (prev.runningSubagents ?? 0) - 1)
      if (runningSubagents === prev.runningSubagents) return prev
      logForDebugging('[AgentConcurrency] released running=' + runningSubagents)
      return { ...prev, runningSubagents }
    })
  }
}
