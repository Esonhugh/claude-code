import type { ToolUseContext } from '../../Tool.js'

export const MAX_SUBAGENT_DEPTH = 5

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
  if (getCurrentSubagentDepth(options) >= MAX_SUBAGENT_DEPTH) {
    throw new Error(SUBAGENT_DEPTH_LIMIT_MESSAGE)
  }
}
