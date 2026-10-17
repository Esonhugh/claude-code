import { expect, test } from 'bun:test'
import {
  createChannelPermissionCallbacks,
  filterPermissionRelayClients,
  isChannelPermissionRelayEnabled,
  sanitizePermissionText,
  truncateForPreview,
} from './channelPermissions.js'

test('permission relay is available locally and supports explicit opt-out', () => {
  const prior = process.env.CLAUDE_CODE_DISABLE_CHANNEL_PERMISSION_RELAY
  try {
    delete process.env.CLAUDE_CODE_DISABLE_CHANNEL_PERMISSION_RELAY
    expect(isChannelPermissionRelayEnabled()).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_CHANNEL_PERMISSION_RELAY = '1'
    expect(isChannelPermissionRelayEnabled()).toBe(false)
  } finally {
    if (prior === undefined)
      delete process.env.CLAUDE_CODE_DISABLE_CHANNEL_PERMISSION_RELAY
    else process.env.CLAUDE_CODE_DISABLE_CHANNEL_PERMISSION_RELAY = prior
  }
})

test('permission capability false is an explicit opt-out', () => {
  const clients = [
    {
      name: 'approved',
      type: 'connected',
      capabilities: {
        experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      },
    },
    {
      name: 'opt-out',
      type: 'connected',
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': false,
        },
      },
    },
    {
      name: 'not-channel',
      type: 'connected',
      capabilities: {
        experimental: {
          'claude/channel': false,
          'claude/channel/permission': {},
        },
      },
    },
    {
      name: 'blocked',
      type: 'connected',
      capabilities: {
        experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      },
    },
    {
      name: 'offline',
      type: 'failed',
      capabilities: {
        experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      },
    },
  ]
  expect(
    filterPermissionRelayClients(
      clients,
      client => client.name !== 'blocked',
    ).map(client => client.name),
  ).toEqual(['approved'])
})

test('permission callbacks accept only pending IDs and resolve once', () => {
  const callbacks = createChannelPermissionCallbacks()
  const replies: unknown[] = []
  const unsubscribe = callbacks.onResponse('abcde', response =>
    replies.push(response),
  )
  expect(callbacks.resolve('unknown', 'allow', 'server')).toBe(false)
  expect(callbacks.resolve('ABCDE', 'deny', 'server')).toBe(true)
  expect(callbacks.resolve('abcde', 'allow', 'server')).toBe(false)
  expect(replies).toEqual([{ behavior: 'deny', fromServer: 'server' }])
  callbacks.onResponse('abcde', response => replies.push(response))()
  expect(callbacks.resolve('abcde', 'allow', 'server')).toBe(false)
  unsubscribe()
})

test('permission preview retains command tail and limits each field by code point', () => {
  const command = '😀'.repeat(3501) + ' ; rm important.txt'
  const preview = JSON.parse(truncateForPreview({ command, path: 'keep.txt' }))
  expect(preview.command).toContain('code points elided')
  expect(preview.command.endsWith(' ; rm important.txt')).toBe(true)
  expect(preview.path).toBe('keep.txt')
  expect(preview.command).not.toContain('\uFFFD')
  expect(Array.from(preview.command).length).toBeLessThanOrEqual(3500)
})

test('permission preview neutralizes spoofing and masks recognizable credentials', () => {
  const key = 'sk-ant-api03-' + 'x'.repeat(80)
  const preview = truncateForPreview({
    command: 'echo \u202Ehidden\u200B\n  “＜text＞”',
    [key]: key,
    nested: { [key]: key },
  })
  expect(preview).not.toContain('\u202E')
  expect(preview).not.toContain('\u200B')
  expect(preview).not.toContain('“')
  expect(preview).not.toContain('＜')
  expect(preview).not.toContain(key)
  expect(preview).toContain('[REDACTED]')
})

test('unserializable field does not discard other preview fields', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(
    JSON.parse(truncateForPreview({ circular, path: 'keep.txt' })),
  ).toEqual({ circular: '(value unserializable)', path: 'keep.txt' })
})

test('masking cannot hide shell syntax or a path/URL destination', () => {
  const key = 'sk-ant-api03-' + 'x'.repeat(80)
  for (const value of [
    key + '/file',
    'https://' + key,
    key + ';danger',
    key + '$(danger)',
  ]) {
    expect(sanitizePermissionText(value)).toBe(value)
  }
})

test('preview limits huge arrays and preserves unrelated fields', () => {
  expect(
    JSON.parse(
      truncateForPreview({ huge: Array(10001).fill(1), path: 'keep.txt' }),
    ),
  ).toEqual({ huge: '(value unserializable)', path: 'keep.txt' })
})
