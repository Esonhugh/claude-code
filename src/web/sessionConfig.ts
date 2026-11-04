import type { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

/**
 * What one claude web session loads, on top of the global settings
 * (issue #796). Every field is optional; a missing one keeps the global
 * behavior. Applied when the session's `claude -p` process is spawned.
 */
export type SessionConfig = {
  /** `name@marketplace` → on/off (`enabledPlugins` in `--settings`); mods are plugins with hook modules. */
  plugins?: Record<string, boolean>
  /** MCP server name → on/off for this session (`sessionMcpServers` in `--settings`). */
  mcp?: Record<string, boolean>
  /** `plugin:<name>@<marketplace>` entries for `--channels`; replaces the new-session defaults. */
  channels?: string[]
  /** false: `disableAllHooks` for this session (mods are hooks too, so they stop as well). */
  hooks?: false
}

export type Profile = { id: string; name: string; config: SessionConfig; created_at: number; updated_at: number }

export type SessionConfigRow = { profile_id: string | null; config: SessionConfig }

const PLUGIN_ID = /^[A-Za-z0-9][\w.-]{0,127}@[A-Za-z0-9][\w.-]{0,127}$/
const MCP_NAME = /^[\w.:-]{1,200}$/
const CHANNEL_ENTRY = /^plugin:[A-Za-z0-9][\w.-]{0,127}@[A-Za-z0-9][\w.-]{0,127}$/

export const sessionConfigSchema = lazySchema(() =>
  z
    .object({
      plugins: z.record(z.string().regex(PLUGIN_ID), z.boolean()).optional(),
      mcp: z.record(z.string().regex(MCP_NAME), z.boolean()).optional(),
      channels: z.array(z.string().regex(CHANNEL_ENTRY)).max(50).optional(),
      hooks: z.literal(false).optional(),
    })
    .strict(),
)

export const SESSION_CONFIG_MIGRATION = [
  `CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE session_configs (
    session_id TEXT PRIMARY KEY,
    profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
    config TEXT NOT NULL DEFAULT '{}'
  )`,
]

function parseConfig(raw: string): SessionConfig {
  try {
    const parsed = sessionConfigSchema().safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/** The profile's config with the session's own entries on top. */
export function mergeConfig(base: SessionConfig, own: SessionConfig): SessionConfig {
  const plugins = { ...base.plugins, ...own.plugins }
  const mcp = { ...base.mcp, ...own.mcp }
  const channels = own.channels ?? base.channels
  const hooks = own.hooks ?? base.hooks
  return {
    ...(Object.keys(plugins).length && { plugins }),
    ...(Object.keys(mcp).length && { mcp }),
    ...(channels && { channels }),
    ...(hooks === false && { hooks }),
  }
}

/** `--channels` entries and the `--settings` JSON for a session's process. */
export function spawnFlags(config: SessionConfig, defaultChannels: string[]): { channels: string[]; settings?: string } {
  const settings = {
    ...(config.plugins && { enabledPlugins: config.plugins }),
    ...(config.mcp && { sessionMcpServers: config.mcp }),
    ...(config.hooks === false && { disableAllHooks: true }),
  }
  return {
    channels: config.channels ?? defaultChannels,
    ...(Object.keys(settings).length && { settings: JSON.stringify(settings) }),
  }
}

type ProfileRow = { id: string; name: string; config: string; created_at: number; updated_at: number }
const toProfile = (row: ProfileRow): Profile => ({ ...row, config: parseConfig(row.config) })

export class SessionConfigStore {
  constructor(private db: Database) {}

  profiles(): Profile[] {
    return (this.db.query('SELECT * FROM profiles ORDER BY name COLLATE NOCASE').all() as ProfileRow[]).map(toProfile)
  }

  profile(id: string): Profile | undefined {
    const row = this.db.query('SELECT * FROM profiles WHERE id = ?').get(id) as ProfileRow | null
    return row ? toProfile(row) : undefined
  }

  saveProfile(id: string | undefined, name: string, config: SessionConfig): Profile {
    const now = Date.now()
    if (id) {
      this.db.run('UPDATE profiles SET name = ?, config = ?, updated_at = ? WHERE id = ?', [name, JSON.stringify(config), now, id])
    } else {
      id = randomUUID()
      this.db.run('INSERT INTO profiles (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
        id,
        name,
        JSON.stringify(config),
        now,
        now,
      ])
    }
    return this.profile(id)!
  }

  deleteProfile(id: string): boolean {
    return this.db.run('DELETE FROM profiles WHERE id = ?', [id]).changes > 0
  }

  /** Session ids that use this profile. */
  sessionsWith(profileId: string): string[] {
    return (this.db.query('SELECT session_id FROM session_configs WHERE profile_id = ?').all(profileId) as { session_id: string }[]).map(
      r => r.session_id,
    )
  }

  get(sessionId: string): SessionConfigRow {
    const row = this.db.query('SELECT profile_id, config FROM session_configs WHERE session_id = ?').get(sessionId) as
      | { profile_id: string | null; config: string }
      | null
    return row ? { profile_id: row.profile_id, config: parseConfig(row.config) } : { profile_id: null, config: {} }
  }

  set(sessionId: string, row: SessionConfigRow): void {
    if (!row.profile_id && !Object.keys(row.config).length) {
      this.db.run('DELETE FROM session_configs WHERE session_id = ?', [sessionId])
      return
    }
    this.db.run(
      'INSERT INTO session_configs (session_id, profile_id, config) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET profile_id = excluded.profile_id, config = excluded.config',
      [sessionId, row.profile_id, JSON.stringify(row.config)],
    )
  }

  /** The config the session's process starts with: its profile, then its own entries. */
  effective(sessionId: string): SessionConfig {
    const row = this.get(sessionId)
    const profile = row.profile_id ? this.profile(row.profile_id) : undefined
    return mergeConfig(profile?.config ?? {}, row.config)
  }
}
