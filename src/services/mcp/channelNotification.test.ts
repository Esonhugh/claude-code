import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import {
  getAllowedChannels,
  setAllowedChannels,
} from '../../bootstrap/state.js'
;(globalThis as typeof globalThis & { MACRO: MacroGlobals }).MACRO = {
  VERSION: 'test',
}
const auth = await import('../../utils/auth.js')
const settings = await import('../../utils/settings/settings.js')
const growthbook = await import('../analytics/growthbook.js')
const {
  gateChannelServer,
  wrapChannelMessage,
  ChannelMessageNotificationSchema,
} = await import('./channelNotification.js')
const { getChannelAllowlist, isChannelAllowlisted, isChannelsEnabled } =
  await import('./channelAllowlist.js')

const capabilities = { experimental: { 'claude/channel': {} } }
const priorChannels = getAllowedChannels()
const policy = spyOn(settings, 'getSettingsForSource')
const subscription = spyOn(auth, 'getSubscriptionType')
const oauth = spyOn(auth, 'getClaudeAIOAuthTokens')
const remote = spyOn(growthbook, 'getFeatureValue_CACHED_MAY_BE_STALE')
const priorDisable = process.env.CLAUDE_CODE_DISABLE_CHANNELS

afterAll(() => {
  for (const mock of [policy, subscription, oauth, remote]) mock.mockRestore()
})

beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_CHANNELS
  setAllowedChannels([
    {
      kind: 'plugin',
      name: 'telegram',
      marketplace: 'claude-plugins-official',
    },
  ])
  policy.mockReturnValue(null)
  subscription.mockReturnValue(null)
  oauth.mockReturnValue(null)
  remote.mockImplementation((_name, fallback) => fallback)
})

afterEach(() => {
  setAllowedChannels(priorChannels)
  if (priorDisable === undefined)
    delete process.env.CLAUDE_CODE_DISABLE_CHANNELS
  else process.env.CLAUDE_CODE_DISABLE_CHANNELS = priorDisable
})

test('channels register without Anthropic OAuth or rollout entitlement', () => {
  remote.mockImplementation(
    <T>(name: string, fallback: T): T =>
      name === 'tengu_harbor' ? (false as T) : fallback,
  )
  expect(isChannelsEnabled()).toBe(true)
  expect(
    gateChannelServer(
      'plugin:telegram:bot',
      capabilities,
      'telegram@claude-plugins-official',
    ),
  ).toEqual({ action: 'register' })
  expect(getChannelAllowlist()).toContainEqual({
    plugin: 'telegram',
    marketplace: 'claude-plugins-official',
  })
})

test('explicit local disable still blocks channel delivery', () => {
  process.env.CLAUDE_CODE_DISABLE_CHANNELS = '1'
  expect(
    gateChannelServer(
      'plugin:telegram:bot',
      capabilities,
      'telegram@claude-plugins-official',
    ),
  ).toMatchObject({ action: 'skip', kind: 'disabled' })
})

test('session selection and declared channel capability are required', () => {
  setAllowedChannels([])
  expect(
    gateChannelServer(
      'plugin:telegram:bot',
      capabilities,
      'telegram@claude-plugins-official',
    ),
  ).toMatchObject({ kind: 'session' })
  expect(
    gateChannelServer(
      'plugin:telegram:bot',
      {
        experimental: { 'claude/channel': false },
      } as unknown as typeof capabilities,
      'telegram@claude-plugins-official',
    ),
  ).toMatchObject({ kind: 'capability' })
})

test('marketplace source must match even for development entries', () => {
  setAllowedChannels([
    {
      kind: 'plugin',
      name: 'telegram',
      marketplace: 'claude-plugins-official',
      dev: true,
    },
  ])
  expect(
    gateChannelServer('plugin:telegram:bot', capabilities, 'telegram@other'),
  ).toMatchObject({ kind: 'marketplace' })
})

test('development bypass is per entry and normal server entries are blocked', () => {
  setAllowedChannels([
    { kind: 'server', name: 'dev', dev: true },
    { kind: 'server', name: 'normal' },
  ])
  expect(gateChannelServer('dev', capabilities, undefined)).toEqual({
    action: 'register',
  })
  expect(gateChannelServer('normal', capabilities, undefined)).toMatchObject({
    kind: 'allowlist',
  })
})

test('managed settings apply to API and compatible providers, including development channels', () => {
  setAllowedChannels([{ kind: 'server', name: 'dev', dev: true }])
  for (const config of [{}, { channelsEnabled: false }]) {
    policy.mockReturnValue(config)
    expect(gateChannelServer('dev', capabilities, undefined)).toMatchObject({
      kind: 'policy',
    })
  }
  policy.mockReturnValue({ channelsEnabled: true })
  expect(gateChannelServer('dev', capabilities, undefined)).toEqual({
    action: 'register',
  })
  policy.mockReturnValue(undefined)
  subscription.mockReturnValue('team')
  expect(gateChannelServer('dev', capabilities, undefined)).toMatchObject({
    kind: 'policy',
  })
})

test('organization plugin list replaces the default for gate and SDK discovery', () => {
  policy.mockReturnValue({
    channelsEnabled: true,
    allowedChannelPlugins: [{ plugin: 'internal', marketplace: 'acme' }],
  })
  expect(isChannelAllowlisted('internal@acme')).toBe(true)
  expect(isChannelAllowlisted('telegram@claude-plugins-official')).toBe(false)
  setAllowedChannels([
    { kind: 'plugin', name: 'internal', marketplace: 'acme' },
  ])
  expect(
    gateChannelServer('plugin:internal:bot', capabilities, 'internal@acme'),
  ).toEqual({ action: 'register' })
  policy.mockReturnValue({ channelsEnabled: true, allowedChannelPlugins: [] })
  expect(
    gateChannelServer('plugin:internal:bot', capabilities, 'internal@acme'),
  ).toMatchObject({ kind: 'allowlist' })
})

test('permission relay uses the complete channel gate including policy and provenance', async () => {
  const { filterPermissionRelayClients } =
    await import('./channelPermissions.js')
  const relayCapabilities = {
    experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
  }
  const clients = [
    {
      type: 'connected',
      name: 'plugin:telegram:bot',
      capabilities: relayCapabilities,
      config: { pluginSource: 'telegram@other' },
    },
  ]
  const admitted = (client: (typeof clients)[number]) =>
    gateChannelServer(
      client.name,
      client.capabilities,
      client.config.pluginSource,
    ).action === 'register'
  expect(filterPermissionRelayClients(clients, admitted)).toEqual([])
  clients[0]!.config.pluginSource = 'telegram@claude-plugins-official'
  expect(filterPermissionRelayClients(clients, admitted)).toHaveLength(1)
  policy.mockReturnValue({ channelsEnabled: false })
  expect(filterPermissionRelayClients(clients, admitted)).toEqual([])
})

test('malformed or explicitly empty remote allowlists fail closed', () => {
  remote.mockReturnValue([])
  expect(getChannelAllowlist()).toEqual([])
  remote.mockReturnValue({ plugin: 'telegram' })
  expect(getChannelAllowlist()).toEqual([])
})

test('channel notification schema and metadata escaping preserve routing provenance', () => {
  expect(
    ChannelMessageNotificationSchema().safeParse({
      method: 'notifications/claude/channel',
      params: { content: 'hello', meta: { user: 1 } },
    }).success,
  ).toBe(false)
  expect(
    wrapChannelMessage('real', '/help', {
      source: 'spoofed',
      chat_id: 'a"b',
      'bad-key': 'ignored',
    }),
  ).toBe('<channel source="real" chat_id="a&quot;b">\n/help\n</channel>')
})
