import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Implementation, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

const childFlag = 'CLAUDE_CODE_SDK_SERVER_INFO_TEST_CHILD'
if (process.env[childFlag] !== '1') {
  test('SDK initialize metadata survives connection setup (isolated)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-sdk-info-')))
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_API_KEY_|CLAUDE_CODE_USE_|CLAUDE_CODE_REMOTE|CLAUDE_CODE_ENTRYPOINT)/.test(key)))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...env, [childFlag]: '1', HOME: root, CLAUDE_CONFIG_DIR: root,
          ANTHROPIC_API_KEY: 'test-only-placeholder', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) throw new Error(stdout + '\n' + stderr)
      console.log((stdout + stderr).match(/\d+ pass[\s\S]*?Ran [^\n]+/)?.[0])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
} else {
  ;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = { VERSION: 'test' }
  const { setupSdkMcpClients } = await import('./client.js')
  const { getMcpInstructionsDelta } = await import('../../utils/mcpInstructionsDelta.js')
  const { getMcpInstructionsDeltaAttachment } = await import('../../utils/attachments.js')
  const versions: Implementation[] = [
    { name: 'owned-sdk-fixture', version: '1.0.0' },
    { name: 'owned-sdk-metadata', version: '2.0.0', title: 'Owned SDK',
      description: 'Fixture implementation', websiteUrl: 'https://owned.invalid/sdk',
      icons: [{ src: 'https://owned.invalid/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'], theme: 'dark' }] },
  ]
  for (const serverInfo of versions) {
    test(`connected SDK client retains ${serverInfo.name} initialize metadata`, async () => {
      const messages: JSONRPCMessage[] = []
      const result = await setupSdkMcpClients({ owned: { type: 'sdk', name: 'owned' } }, async (name, message) => {
        expect(name).toBe('owned')
        messages.push(message)
        if ('method' in message && message.method === 'initialize' && 'id' in message) {
          return { jsonrpc: '2.0', id: message.id,
            result: { protocolVersion: '2025-11-25', serverInfo, capabilities: {} } }
        }
        if ('id' in message) return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
        return { jsonrpc: '2.0', method: 'notifications/owned-fixture' }
      })
      try {
        expect(result.clients).toHaveLength(1)
        const connection = result.clients[0]!
        expect(connection.type).toBe('connected')
        if (connection.type !== 'connected') throw new Error('Expected the actual SDK handshake to connect')
        // Official 2.1.292 copies getServerVersion() into this connected record.
        expect(connection.client.getServerVersion()).toEqual(serverInfo)
        expect(connection.serverInfo).toEqual(serverInfo)
        expect(connection.config).toEqual({ type: 'sdk', name: 'owned', scope: 'dynamic' })
        expect(result.tools).toEqual([])
        expect(messages.filter(m => 'method' in m).map(m => m.method)).toEqual(['initialize', 'notifications/initialized'])
      } finally {
        await Promise.all(result.clients.map(c => c.type === 'connected' ? c.cleanup() : Promise.resolve()))
      }
    })
  }

  const instructionCases: Array<{ name: string; input?: string; limit?: string; expected?: string }> = [
    { name: 'absent' },
    { name: 'empty', input: '', expected: '' },
    { name: 'short', input: 'Use the owned tools in server order.', expected: 'Use the owned tools in server order.' },
    { name: 'exact default limit', input: 'x'.repeat(2048), expected: 'x'.repeat(2048) },
    { name: 'over default limit', input: 'x'.repeat(2049), expected: 'x'.repeat(2048) + '… [truncated]' },
    { name: 'surrogate boundary', input: 'x'.repeat(2047) + '😀tail', expected: 'x'.repeat(2047) + '… [truncated]' },
    { name: 'custom limit', input: 'abcdef', limit: '3', expected: 'abc… [truncated]' },
    { name: 'signed padded limit', input: 'abcdef', limit: ' +3 ', expected: 'abc… [truncated]' },
    ...['0', '-1', '3junk', '3.5', 'Infinity', ''].map(limit => ({ name: `invalid limit ${JSON.stringify(limit)}`, input: 'abcdef', limit, expected: 'abcdef' })),
  ]
  for (const { name, input, limit, expected } of instructionCases) {
    test(`SDK initialize instructions reach context: ${name}`, async () => {
      const priorLimit = process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH
      if (limit === undefined) delete process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH
      else process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = limit
      const result = await setupSdkMcpClients({ owned: { type: 'sdk', name: 'owned' } }, async (_, message) => {
        if ('method' in message && message.method === 'initialize' && 'id' in message) {
          return { jsonrpc: '2.0', id: message.id, result: {
            protocolVersion: '2025-11-25', serverInfo: versions[0], capabilities: {},
            ...(input === undefined ? {} : { instructions: input }),
          } }
        }
        if ('id' in message) return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
        return { jsonrpc: '2.0', method: 'notifications/owned-fixture' }
      })
      try {
        expect(result.clients).toHaveLength(1)
        const connection = result.clients[0]!
        expect(connection.type).toBe('connected')
        if (connection.type !== 'connected') throw new Error('Expected the actual SDK handshake to connect')
        expect(connection.client.getInstructions()).toBe(input)
        // Official 2.1.292 retains the processed instructions before either context consumer reads them.
        expect(connection.instructions).toBe(expected)
        expect(getMcpInstructionsDelta(result.clients, [], [])).toEqual(expected ? {
          addedNames: ['owned'], addedBlocks: [`## owned\n${expected}`], removedNames: [],
        } : null)
        expect(getMcpInstructionsDeltaAttachment(result.clients, [], 'claude-sonnet-4-6', [])).toEqual(expected ? [{
          type: 'mcp_instructions_delta', addedNames: ['owned'], addedBlocks: [`## owned\n${expected}`], removedNames: [],
        }] : [])
        expect(result.tools).toEqual([])
      } finally {
        await Promise.all(result.clients.map(c => c.type === 'connected' ? c.cleanup() : Promise.resolve()))
        if (priorLimit === undefined) delete process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH
        else process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = priorLimit
      }
    })
  }

}
