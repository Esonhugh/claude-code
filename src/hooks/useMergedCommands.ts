import uniqBy from 'lodash-es/uniqBy.js'
import { useMemo } from 'react'
import type { Command } from '../commands.js'

export function useMergedCommands(
  initialCommands: Command[],
  mcpCommands: Command[],
): Command[] {
  return useMemo(() => {
    if (mcpCommands.length > 0) {
      const initialNames = new Set(initialCommands.map(command => command.name))
      const uniqueMcpCommands = uniqBy(mcpCommands, 'name').filter(
        command => !initialNames.has(command.name),
      )
      return [...initialCommands, ...uniqueMcpCommands]
    }
    return initialCommands
  }, [initialCommands, mcpCommands])
}
