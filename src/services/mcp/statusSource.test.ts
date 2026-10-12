import { expect, test } from 'bun:test'
import { McpServerStatusSchema } from '../../entrypoints/sdk/coreSchemas.js'
import { SDKControlMcpStatusResponseSchema } from '../../entrypoints/sdk/controlSchemas.js'

// Official 2.1.292 native user-config status includes source: 'user'.
test('status schema preserves the source sent by the CLI', () => {
  const status = {name: 'owned', status: 'failed' as const, scope: 'user', source: 'user'}
  expect(McpServerStatusSchema().parse(status)).toEqual(status)
  expect(SDKControlMcpStatusResponseSchema().parse({mcpServers: [status]})).toEqual({mcpServers: [status]})
})

import { getMcpServerStatusSource, type ScopedMcpServerConfig } from './types.js'
import type { McpServerStatus } from '../../entrypoints/sdk/coreTypes.generated.js'

test('status source is optional, typed, and rejects non-strings', () => {
  const value: McpServerStatus = {name: 'owned', status: 'pending', source: 'user'}
  const source: string | undefined = value.source
  expect(source).toBe('user')
  expect(McpServerStatusSchema().parse({name: 'owned', status: 'pending'})).toEqual({name: 'owned', status: 'pending'})
  expect(McpServerStatusSchema().safeParse({...value, source: 4}).success).toBe(false)
})

for (const scope of ['user', 'local', 'project', 'dynamic', 'enterprise', 'managed', 'claudeai'] as const) {
  test(`plain config retains ${scope} definition origin`, () => {
    expect(getMcpServerStatusSource({type: 'stdio', command: 'node', args: [], scope})).toBe(scope)
  })
}

test('SDK transport and plugin metadata have distinct definition origins', () => {
  const sdk: ScopedMcpServerConfig = {type: 'sdk', name: 'owned', scope: 'dynamic'}
  expect(getMcpServerStatusSource(sdk)).toBe('sdk')
  expect(getMcpServerStatusSource({...sdk, pluginSource: 'owned@local'})).toBe('plugin')
  expect(getMcpServerStatusSource({type: 'stdio', command: 'node', args: [], scope: 'dynamic', pluginSource: ''})).toBe('plugin')
})

test('plugin-like or SDK-like names do not establish definition origin', () => {
  for (const command of ['plugin:owned:server', 'sdk']) {
    expect(getMcpServerStatusSource({type: 'stdio', command, args: [], scope: 'dynamic'})).toBe('dynamic')
  }
})
