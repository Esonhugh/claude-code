import type { ToolUseContext } from '../../Tool.js'

export const MAX_SUBAGENT_DEPTH = 5

export function getMaxSubagentDepth(): number {
  const raw = process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH?.trim() ?? ''
  const value = Number(raw)
  return /^\+?\d+$/.test(raw) && Number.isSafeInteger(value) && value >= 1 ? value : MAX_SUBAGENT_DEPTH
}

export const SUBAGENT_DEPTH_LIMIT_MESSAGE =
  'Subagent nesting limit reached (5). Complete the task directly instead of spawning another agent.'

type OptionsWithDepth = Pick<ToolUseContext['options'], 'subagentDepth'> & {
  spawnDepth?: number
}

export function getCurrentSubagentDepth(options: OptionsWithDepth): number {
  return options.subagentDepth ?? options.spawnDepth ?? 0
}

export function getNextSubagentDepth(options: OptionsWithDepth): number {
  return getCurrentSubagentDepth(options) + 1
}

export function assertCanSpawnNestedSubagent(options: OptionsWithDepth): void {
  const limit = getMaxSubagentDepth()
  if (getCurrentSubagentDepth(options) >= limit) {
    throw new Error(`Subagent nesting limit reached (${limit}). Complete the task directly instead of spawning another agent.`)
  }
}
