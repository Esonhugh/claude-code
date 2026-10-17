import { afterEach, expect, test } from 'bun:test'
import { SettingsSchema } from '../settings/types.js'
import { resetSettingsCache, setCachedSettingsForSource, setSessionSettingsCache } from '../settings/settingsCache.js'
import {
  areSideloadFlagsDisabled,
  getSideloadFlagsError,
  getSideloadStartupError,
  filterSideloadMcpServers,
} from './sideloadPolicy.js'

afterEach(resetSettingsCache)
const sentence = "disabled by your organization's managed settings (disableSideloadFlags). Plugins, custom agents, and MCP servers can only be loaded from sources your administrator has approved. Ask your administrator to remove disableSideloadFlags from managed settings, or use an approved marketplace / settings file instead."

test('disableSideloadFlags is an optional boolean setting', () => {
  for (const value of [true, false]) expect(SettingsSchema().parse({ disableSideloadFlags: value }).disableSideloadFlags).toBe(value)
  expect(SettingsSchema().safeParse({ disableSideloadFlags: 'true' }).success).toBe(false)
})

test('only administrator policy enables the sideload restriction', () => {
  setCachedSettingsForSource('policySettings', null)
  setCachedSettingsForSource('userSettings', { disableSideloadFlags: true })
  setSessionSettingsCache({ settings: { disableSideloadFlags: true }, errors: [] })
  expect(areSideloadFlagsDisabled()).toBe(false)
  setCachedSettingsForSource('policySettings', { disableSideloadFlags: false })
  expect(areSideloadFlagsDisabled()).toBe(false)
  setCachedSettingsForSource('policySettings', { disableSideloadFlags: true })
  expect(areSideloadFlagsDisabled()).toBe(true)
})

// Official 2.1.292 native: startup stops before any authored plugin loads.
test('startup errors preserve official order, grammar, and environment recovery hint', () => {
  setCachedSettingsForSource('policySettings', { disableSideloadFlags: true })
  expect(getSideloadStartupError({ pluginDir: ['/tmp/plugin'] }, [])).toBe(`--plugin-dir is ${sentence}`)
  expect(getSideloadStartupError({ agents: '{}' }, [])).toBe(`--agents is ${sentence}`)
  expect(getSideloadStartupError({ pluginDir: ['/tmp/plugin'], agents: '{}' }, ['/tmp/env']))
    .toBe(`--plugin-dir, --agents, CLAUDE_CODE_PLUGIN_DIRS are ${sentence} Unset CLAUDE_CODE_PLUGIN_DIRS (in the environment, or in the settings \`env\` block that sets it) to run without those folders.`)
  expect(getSideloadStartupError({ pluginDir: [], agents: '' }, [])).toBeUndefined()
  expect(getSideloadStartupError({ pluginDir: [] }, [], { pluginDir: ['/tmp/action'] })).toBe(`--plugin-dir is ${sentence}`)
  expect(getSideloadFlagsError(['--mcp-config'])).toBe(`--mcp-config is ${sentence}`)
})

test('startup uses explicit flag values rather than truthiness and policy changes take effect', () => {
  setCachedSettingsForSource('policySettings', { disableSideloadFlags: true })
  expect(getSideloadStartupError({ pluginDir: false, agents: 1 }, [])).toBeUndefined()
  expect(getSideloadStartupError({ pluginDirNoMcp: ['/tmp/no-mcp'], pluginUrl: ['https://example.invalid/mod'] }, []))
    .toBe(`--plugin-dir-no-mcp, --plugin-url are ${sentence}`)
  setCachedSettingsForSource('policySettings', { disableSideloadFlags: false })
  expect(getSideloadStartupError({ pluginDir: ['/tmp/plugin'] }, ['/tmp/env'])).toBeUndefined()
})

// Official 2.1.292 native: server-delivered MCP is dropped remotely;
// local mcp_set_servers is still admitted and SDK transports are retained.
test('MCP filtering retains SDK transports and preserves original config identities', () => {
  const sdk = { type: 'sdk' as const, name: 'owned-sdk' }
  const process = { type: 'stdio' as const, command: '/usr/bin/true', args: [] }
  const configs = { sdk, process }
  expect(filterSideloadMcpServers(configs, false)).toEqual({ servers: configs, dropped: [] })
  const filtered = filterSideloadMcpServers(configs, true)
  expect(filtered).toEqual({ servers: { sdk }, dropped: ['process'] })
  expect(filtered.servers.sdk).toBe(sdk)
  expect(configs.process).toBe(process)
})
