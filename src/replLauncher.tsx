import React from 'react'
import { getIsRemoteMode } from './bootstrap/state.js'
import type { StatsStore } from './context/stats.js'
import type { Root } from './ink.js'
import type { Props as REPLProps } from './screens/REPL.js'
import type { AppState } from './state/AppStateStore.js'
import { noteReplLaunchPermissionMode } from './tools/REPLTool/codeModeGate.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
}

export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>,
): Promise<void> {
  // Official t8t: a local terminal session launched in auto or
  // bypassPermissions asks for event delivery, which brings Code Mode's Poll.
  const { remoteSessionConfig, directConnectConfig, sshSession } = replProps
  if (!(getIsRemoteMode() || remoteSessionConfig || directConnectConfig || sshSession))
    noteReplLaunchPermissionMode(appProps.initialState.toolPermissionContext.mode)
  const { App } = await import('./components/App.js')
  const { REPL } = await import('./screens/REPL.js')
  await renderAndRun(
    root,
    <App {...appProps}>
      <REPL {...replProps} />
    </App>,
  )
}
