import { expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { prepareChannelTransport } from './channelCapabilities.js'

test('MCP handshake permits channel permission false without granting relay', async () => {
  const transport: Transport = {
    async start() {},
    async close() {
      transport.onclose?.()
    },
    async send(message) {
      if (
        'method' in message &&
        message.method === 'initialize' &&
        'id' in message
      ) {
        transport.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            serverInfo: { name: 'fixture', version: '1' },
            capabilities: {
              tools: {},
              experimental: {
                'claude/channel': {},
                'claude/channel/permission': false,
              },
            },
          },
        })
      }
    },
  }
  const client = new Client(
    { name: 'test', version: '1' },
    { capabilities: {} },
  )
  prepareChannelTransport(transport)
  try {
    await client.connect(transport)
    expect(
      client.getServerCapabilities()?.experimental?.['claude/channel'],
    ).toEqual({})
    expect(
      client.getServerCapabilities()?.experimental?.[
        'claude/channel/permission'
      ],
    ).toBeUndefined()
  } finally {
    await client.close()
  }
})

test('transport adapter preserves other capabilities, messages and existing handlers', () => {
  const received: JSONRPCMessage[] = []
  const transport: Transport = {
    async start() {},
    async close() {},
    async send() {},
    onmessage: message => {
      received.push(message)
    },
  }
  prepareChannelTransport(transport)
  const capabilities = {
    experimental: {
      'claude/channel': {},
      'claude/channel/permission': {},
      unrelated: false,
    },
  }
  const initialize: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'fixture', version: '1' },
      capabilities,
    },
  }
  const ordinary: JSONRPCMessage = {
    jsonrpc: '2.0',
    id: 2,
    result: {
      capabilities: { experimental: { 'claude/channel/permission': false } },
    },
  }
  transport.onmessage!(initialize)
  transport.onmessage!(ordinary)
  expect(received).toEqual([initialize, ordinary])
  expect(capabilities.experimental['claude/channel/permission']).toEqual({})
  expect(capabilities.experimental.unrelated).toBe(false)
  expect(ordinary.result.capabilities).toEqual({
    experimental: { 'claude/channel/permission': false },
  })
})
