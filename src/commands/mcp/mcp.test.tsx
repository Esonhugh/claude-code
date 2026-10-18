import { afterAll, expect, mock, test } from 'bun:test'
import React from 'react'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MCPServerConnection } from '../../services/mcp/types.js'

const home = mkdtempSync(join(tmpdir(), 'mcp-command-test-'))
const originalHome = process.env.HOME
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
process.env.HOME = home
process.env.CLAUDE_CONFIG_DIR = home
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  rmSync(home, { recursive: true, force: true })
})

Object.defineProperty(globalThis, 'MACRO', { configurable: true, value: { VERSION: 'test' } })
const toggled: string[] = []
const reconnected: string[] = []
const realManager = await import('../../services/mcp/MCPConnectionManager.js')
mock.module('../../services/mcp/MCPConnectionManager.js', () => ({
  ...realManager,
  useMcpToggleEnabled: () => async (name: string) => { toggled.push(name) },
  useMcpReconnect: () => async (name: string) => {
    reconnected.push(name)
    return { client: { name, type: name === 'broken' ? 'connected' : 'needs-auth', config }, tools: [], commands: [] }
  },
}))
const { call } = await import('./mcp.js')
const { render } = await import('../../ink.js')
const { AppStateProvider } = await import('../../state/AppState.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')

const config = { type: 'stdio' as const, command: 'owned-fixture', args: [], scope: 'local' as const }
const clients: MCPServerConnection[] = [
  { name: 'on', type: 'pending', config },
  { name: 'off', type: 'disabled', config },
]

async function runMcp(args: string, mcpClients = clients): Promise<string | undefined> {
  const defaults = getDefaultAppState()
  let result: string | undefined
  const element = await call(r => { result = r }, {}, args)
  const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { columns: 100, rows: 30 })
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const instance = await render(
    <AppStateProvider initialState={{ ...defaults, mcp: { ...defaults.mcp, clients: mcpClients } }}>{element}</AppStateProvider>,
    { stdout: stdout as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, patchConsole: false, exitOnCtrlC: false },
  )
  try {
    for (let i = 0; i < 50 && result === undefined; i++) await Bun.sleep(10)
    return result
  } finally { instance.unmount() }
}

// Official 2.1.292 /mcp enable|disable <name> only toggles servers not already in the target state.
test.each([
  { args: 'enable on', expected: 'MCP server "on" is already enabled', toggles: [] },
  { args: 'disable off', expected: 'MCP server "off" is already disabled', toggles: [] },
  { args: 'enable off', expected: 'MCP server "off" enabled', toggles: ['off'] },
  { args: 'disable on', expected: 'MCP server "on" disabled', toggles: ['on'] },
  { args: 'enable missing', expected: 'MCP server "missing" not found', toggles: [] },
])('/mcp $args', async ({ args, expected, toggles }) => {
  toggled.length = 0
  expect(await runMcp(args)).toBe(expected)
  expect(toggled).toEqual([...toggles])
})

// Official 2.1.292 /mcp reconnect all retries failed and needs-auth servers.
test('/mcp reconnect all reconnects servers that are not connected', async () => {
  reconnected.length = 0
  const mixed: MCPServerConnection[] = [
    ...clients,
    { name: 'broken', type: 'failed', config },
    { name: 'locked', type: 'needs-auth', config },
    { name: 'ide', type: 'failed', config },
  ]
  expect(await runMcp('reconnect all', mixed)).toBe(
    'Reconnected 1 of 2 MCP servers (1 still not connected — run /mcp to check)',
  )
  expect(reconnected).toEqual(['broken', 'locked'])
})

test('/mcp reconnect all with nothing to reconnect', async () => {
  reconnected.length = 0
  expect(await runMcp('reconnect all')).toBe('No MCP servers need reconnecting')
  expect(reconnected).toEqual([])
})
