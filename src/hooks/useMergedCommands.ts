import uniqBy from 'lodash-es/uniqBy.js'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Command } from '../commands.js'
import type { ModCommands } from '../services/mods/commands.js'
import { logError } from '../utils/log.js'

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
  mods?: Pick<ModCommands, 'subscribe' | 'getSnapshot' | 'projection' | 'describe'>,
): Command[] {
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
  return useModCommandProjection(
    disableSlashCommands ? emptyModCommands : mergedCommands,
    disableSlashCommands || isRemoteExecutionSession ? undefined : mods,
  )
}

export function useModCommandProjection(
  commands: Command[],
  mods?: Pick<ModCommands, 'subscribe' | 'getSnapshot' | 'projection' | 'describe'>,
): Command[] {
  const snapshot = useSyncExternalStore(
    mods?.subscribe ?? subscribeEmptyMods,
    mods?.getSnapshot ?? getEmptyModCommands,
    getEmptyModCommands,
  )
  useEffect(() => {
    if (mods) void mods.describe(commands).catch(logError)
  }, [commands, mods, snapshot])
  return useMemo(() => mods?.projection(commands) ?? commands, [commands, mods, snapshot])
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
