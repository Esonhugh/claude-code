import uniqBy from 'lodash-es/uniqBy.js'
import { useMemo, useSyncExternalStore } from 'react'
import type { Command } from '../commands.js'
import type { ModCommands } from '../services/mods/commands.js'

const emptyModCommands: Command[] = []
const getEmptyModCommands = () => emptyModCommands
const subscribeEmptyMods = () => () => {}

export function useReplCommands(
  localCommands: Command[],
  pluginCommands: Command[],
  mcpCommands: Command[],
  pluginReconnectKey: number,
  isRemoteExecutionSession: boolean,
  disableSlashCommands: boolean,
  mods?: Pick<ModCommands, 'subscribe' | 'getSnapshot' | 'projection'>,
): Command[] {
  const modCommands = useSyncExternalStore(
    mods?.subscribe ?? subscribeEmptyMods,
    mods?.getSnapshot ?? getEmptyModCommands,
    getEmptyModCommands,
  )
  const localCommandsWithoutReloadedPlugins = useMemo(
    () =>
      !isRemoteExecutionSession && pluginReconnectKey > 0
        ? localCommands.filter(
            command => command.type !== 'prompt' || command.source !== 'plugin',
          )
        : localCommands,
    [localCommands, isRemoteExecutionSession, pluginReconnectKey],
  )
  const commandsWithPlugins = useMergedCommands(
    localCommandsWithoutReloadedPlugins,
    isRemoteExecutionSession ? [] : pluginCommands,
  )
  const mergedCommands = useMergedCommands(
    commandsWithPlugins,
    isRemoteExecutionSession ? [] : mcpCommands,
  )
  return useMemo(
    () => disableSlashCommands ? [] : !isRemoteExecutionSession && mods ? mods.projection(mergedCommands) : mergedCommands,
    [disableSlashCommands, isRemoteExecutionSession, mergedCommands, mods, modCommands],
  )
}

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
