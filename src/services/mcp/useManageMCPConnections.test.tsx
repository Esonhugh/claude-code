import { expect, spyOn, test } from 'bun:test'
import React from 'react'
import { Writable } from 'node:stream'
import type { AppStateStore } from '../../state/AppStateStore.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from './types.js'

;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = { VERSION: 'test' }
const configModule = await import('./config.js')
const clientModule = await import('./client.js')
const { render } = await import('../../ink.js')
const { AppStateProvider, getDefaultAppState, useAppStateStore } = await import('../../state/AppState.js')
const { useManageMCPConnections } = await import('./useManageMCPConnections.js')

class TestStdout extends Writable {
  columns = 120
  rows = 40
  isTTY = false
  _write(_chunk: unknown, _encoding: string, callback: () => void) { callback() }
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('MCP lifecycle condition was not reached')
}

test('plugin reload waits for old cleanup before connection discovery', async () => {
  const name = 'plugin:fixture:server'
  const config: ScopedMcpServerConfig = { type: 'stdio', command: 'unused-test-command', args: [], scope: 'dynamic' }
  const events: string[] = []
  let release!: () => void
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const client = { onclose: () => { throw new Error('stale onclose must be detached') } }
  const initial = getDefaultAppState()
  initial.mcp.clients = [{ name, type: 'connected', config, client } as unknown as MCPServerConnection]
  let store: AppStateStore | undefined
  const mocks = [
    spyOn(configModule, 'getClaudeCodeMcpConfigs').mockImplementation(async (...args) => {
      events.push(args.length === 1 ? 'initialize' : 'discover')
      return { servers: { [name]: config }, errors: [] }
    }),
    spyOn(configModule, 'isMcpServerDisabled').mockReturnValue(false),
    spyOn(configModule, 'doesEnterpriseMcpConfigExist').mockReturnValue(true),
    spyOn(clientModule, 'clearServerCache').mockImplementation(async () => {
      events.push('cleanup-start')
      await cleanup
      events.push('cleanup-end')
    }),
    spyOn(clientModule, 'getMcpToolsCommandsAndResources').mockImplementation(async () => { events.push('connect') }),
  ]
  function Harness() {
    store = useAppStateStore()
    useManageMCPConnections(undefined, false)
    return null
  }
  const instance = await render(<AppStateProvider initialState={initial}><Harness /></AppStateProvider>, {
    stdout: new TestStdout() as unknown as NodeJS.WriteStream, patchConsole: false,
  })
  try {
    await waitFor(() => events.includes('connect'))
    expect(events).not.toContain('cleanup-start')
    events.length = 0
    store!.setState(state => ({ ...state, mcp: { ...state.mcp, pluginReconnectKey: state.mcp.pluginReconnectKey + 1 } }))
    await waitFor(() => events.includes('cleanup-start'))
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toEqual(['initialize', 'cleanup-start'])
    expect(client.onclose).toBeUndefined()
    expect(store!.getState().mcp.clients.find(entry => entry.name === name)?.type).toBe('pending')
    release()
    await waitFor(() => events.includes('connect'))
    expect(events).toEqual(['initialize', 'cleanup-start', 'cleanup-end', 'discover', 'connect'])
  } finally {
    release()
    instance.unmount()
    instance.cleanup()
    for (const mock of mocks) mock.mockRestore()
  }
})

type HookResult = ReturnType<typeof useManageMCPConnections>

async function renderRemoteServer(name: string, getConfig: () => ScopedMcpServerConfig) {
  let disabled = false
  const oldClient: { onclose?: () => void } = {}
  let store: AppStateStore | undefined
  let hook: HookResult | undefined
  const cleared: ScopedMcpServerConfig[] = []
  const mocks = [
    spyOn(configModule, 'getClaudeCodeMcpConfigs').mockImplementation(async () => ({ servers: { [name]: getConfig() }, errors: [] })),
    spyOn(configModule, 'isMcpServerDisabled').mockImplementation(() => disabled),
    spyOn(configModule, 'setMcpServerEnabled').mockImplementation((_name, enabled) => { disabled = !enabled }),
    spyOn(configModule, 'doesEnterpriseMcpConfigExist').mockReturnValue(true),
    spyOn(clientModule, 'clearServerCache').mockImplementation(async (_name, config) => { cleared.push(config) }),
    spyOn(clientModule, 'getMcpToolsCommandsAndResources').mockImplementation(async (onConnectionAttempt, configs) => {
      const config = configs?.[name]
      if (config && cleared.length === 0)
        onConnectionAttempt({ client: { name, type: 'connected', config, client: oldClient, capabilities: {}, cleanup: async () => {} } as unknown as MCPServerConnection, tools: [], commands: [] })
    }),
  ]
  function Harness() {
    store = useAppStateStore()
    hook = useManageMCPConnections(undefined, false)
    return null
  }
  const instance = await render(<AppStateProvider initialState={getDefaultAppState()}><Harness /></AppStateProvider>, {
    stdout: new TestStdout() as unknown as NodeJS.WriteStream, patchConsole: false,
  })
  await waitFor(() => store!.getState().mcp.clients.find(c => c.name === name)?.type === 'connected')
  return {
    oldClient, cleared,
    get store() { return store! },
    get hook() { return hook! },
    dispose() {
      instance.unmount()
      instance.cleanup()
      for (const mock of mocks) mock.mockRestore()
    },
  }
}

function connectedResult(name: string, config: ScopedMcpServerConfig) {
  const client: { onclose?: () => void } = {}
  return { client: { name, type: 'connected', config, client, capabilities: {}, cleanup: async () => {} } as unknown as MCPServerConnection, tools: [], commands: [] }
}

test('manual reconnect detaches the old onclose so a remote close cannot start a second reconnect', async () => {
  const name = 'remote-manual'
  const config: ScopedMcpServerConfig = { type: 'http', url: 'http://127.0.0.1:9/mcp', scope: 'dynamic' }
  const harness = await renderRemoteServer(name, () => config)
  let closed = false
  const reconnect = spyOn(clientModule, 'reconnectMcpServerImpl').mockImplementation(async () => {
    // Real reconnectMcpServerImpl closes the old client through clearServerCache.
    if (!closed) { closed = true; harness.oldClient.onclose?.() }
    return connectedResult(name, config)
  })
  try {
    await harness.hook.reconnectMcpServer(name)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(harness.oldClient.onclose).toBeUndefined()
  } finally {
    reconnect.mockRestore()
    harness.dispose()
  }
})

test('an in-flight automatic reconnect does not overwrite a disable', async () => {
  const name = 'remote-disable'
  const config: ScopedMcpServerConfig = { type: 'http', url: 'http://127.0.0.1:9/mcp', scope: 'dynamic' }
  const harness = await renderRemoteServer(name, () => config)
  const pending = Promise.withResolvers<ReturnType<typeof connectedResult>>()
  const reconnect = spyOn(clientModule, 'reconnectMcpServerImpl').mockImplementation(() => pending.promise)
  try {
    harness.oldClient.onclose!()
    await waitFor(() => reconnect.mock.calls.length === 1 && harness.store.getState().mcp.clients.find(c => c.name === name)?.type === 'pending')
    await harness.hook.toggleMcpServer(name)
    await waitFor(() => harness.store.getState().mcp.clients.find(c => c.name === name)?.type === 'disabled')
    harness.cleared.length = 0
    const late = connectedResult(name, config)
    pending.resolve(late)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(harness.store.getState().mcp.clients.find(c => c.name === name)?.type).toBe('disabled')
    expect(harness.cleared).toEqual([config])
  } finally {
    reconnect.mockRestore()
    harness.dispose()
  }
})

test('an in-flight automatic reconnect does not overwrite a config change', async () => {
  const name = 'plugin:fixture:remote'
  const oldConfig: ScopedMcpServerConfig = { type: 'http', url: 'http://127.0.0.1:9/old', scope: 'dynamic' }
  const newConfig: ScopedMcpServerConfig = { type: 'http', url: 'http://127.0.0.1:9/new', scope: 'dynamic' }
  let config = oldConfig
  const harness = await renderRemoteServer(name, () => config)
  const pending = Promise.withResolvers<ReturnType<typeof connectedResult>>()
  const reconnect = spyOn(clientModule, 'reconnectMcpServerImpl').mockImplementation(() => pending.promise)
  try {
    harness.oldClient.onclose!()
    await waitFor(() => reconnect.mock.calls.length === 1)
    config = newConfig
    harness.store.setState(state => ({ ...state, mcp: { ...state.mcp, pluginReconnectKey: state.mcp.pluginReconnectKey + 1 } }))
    await waitFor(() => harness.store.getState().mcp.clients.find(c => c.name === name)?.config === newConfig)
    harness.cleared.length = 0
    pending.resolve(connectedResult(name, oldConfig))
    await new Promise(resolve => setTimeout(resolve, 50))
    const entry = harness.store.getState().mcp.clients.find(c => c.name === name)
    expect(entry?.config).toBe(newConfig)
    expect(entry?.type).toBe('pending')
    expect(harness.cleared).toEqual([oldConfig])
  } finally {
    reconnect.mockRestore()
    harness.dispose()
  }
})
