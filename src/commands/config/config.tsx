import * as React from 'react'
import { Settings } from '../../components/Settings/Settings.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { createModConfig } from '../../services/mods/config.js'
import { getConfigRows } from '../../components/Settings/configRows.js'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  if (args?.trim()) {
    const separator = args.indexOf('=')
    if (separator < 1) {
      onDone('Usage: /config key=value', {display:'system'})
      return null
    }
    const key = args.slice(0, separator).trim()
    const text = args.slice(separator + 1).trim()
    let value = text
    try { value = JSON.parse(text) } catch { /* Unquoted text and choice values are strings. */ }
    try {
      const config = context.mods?.config ?? createModConfig(() => getConfigRows(context),async (_event,input,core) => core(input))
      const origin = context.modCommand?.origin
      const result = await config.set({key,value}, origin?.kind === 'bridge' ? {kind:'bridge'} : {kind:'composer'})
      onDone(result.deny ?? `${key} = ${JSON.stringify(result.value)}`, {display:'system'})
    } catch (error) {
      onDone(error instanceof Error ? error.message : String(error), {display:'system'})
    }
    return null
  }
  return <Settings onClose={onDone} context={context} defaultTab="Config" />
}
