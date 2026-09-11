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
