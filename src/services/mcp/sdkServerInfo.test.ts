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
}
