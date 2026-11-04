import { describe, expect, it } from 'bun:test'
import { openProjectsDb } from './projectsDb.js'
import { mergeConfig, SessionConfigStore, sessionConfigSchema, spawnFlags } from './sessionConfig.js'

const SID = '11111111-1111-4111-8111-111111111111'

describe('session config', () => {
  it('lays the session entries over its profile', () => {
    expect(
      mergeConfig(
        { plugins: { 'a@m': true, 'b@m': true }, mcp: { x: false }, channels: ['plugin:fakechat@m'] },
        { plugins: { 'b@m': false }, hooks: false },
      ),
    ).toEqual({ plugins: { 'a@m': true, 'b@m': false }, mcp: { x: false }, channels: ['plugin:fakechat@m'], hooks: false })
    // An empty channel list of the session's own wins over the profile's.
    expect(mergeConfig({ channels: ['plugin:fakechat@m'] }, { channels: [] }).channels).toEqual([])
  })

  it('turns a config into --channels and --settings', () => {
    expect(spawnFlags({}, ['plugin:d@m'])).toEqual({ channels: ['plugin:d@m'] })
    expect(spawnFlags({ channels: [] }, ['plugin:d@m'])).toEqual({ channels: [] })
    const flags = spawnFlags({ plugins: { 'a@m': false }, mcp: { x: true }, hooks: false }, [])
    expect(JSON.parse(flags.settings!)).toEqual({
      enabledPlugins: { 'a@m': false },
      sessionMcpServers: { x: true },
      disableAllHooks: true,
    })
  })

  it('accepts only plugin ids, server names and channel entries', () => {
    expect(sessionConfigSchema().safeParse({ plugins: { '../x': true } }).success).toBe(false)
    expect(sessionConfigSchema().safeParse({ channels: ['--dangerously-skip-permissions'] }).success).toBe(false)
    expect(sessionConfigSchema().safeParse({ hooks: true }).success).toBe(false)
    expect(sessionConfigSchema().safeParse({ extra: 1 }).success).toBe(false)
  })

  it('stores profiles and session rows; deleting a profile leaves the session its own entries', () => {
    const store = new SessionConfigStore(openProjectsDb(':memory:'))
    const p = store.saveProfile(undefined, 'fakechat only', { channels: ['plugin:fakechat@m'] })
    store.set(SID, { profile_id: p.id, config: { hooks: false } })
    expect(store.effective(SID)).toEqual({ channels: ['plugin:fakechat@m'], hooks: false })
    expect(store.sessionsWith(p.id)).toEqual([SID])
    store.saveProfile(p.id, 'renamed', { channels: [] })
    expect(store.profiles().map(x => x.name)).toEqual(['renamed'])
    expect(store.effective(SID).channels).toEqual([])
    store.deleteProfile(p.id)
    expect(store.get(SID)).toEqual({ profile_id: null, config: { hooks: false } })
    store.set(SID, { profile_id: null, config: {} })
    expect(store.get(SID)).toEqual({ profile_id: null, config: {} })
  })
})
