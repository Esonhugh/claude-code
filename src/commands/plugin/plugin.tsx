import * as React from 'react'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { PluginSettings } from './PluginSettings.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  return (
    <PluginSettings
      onComplete={onDone}
      args={args}
      isMainQueryRunning={context.isMainQueryRunning}
    />
  )
}
