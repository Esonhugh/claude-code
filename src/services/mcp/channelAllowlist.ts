/**
 * Approved channel plugins allowlist. --channels plugin:name@marketplace
 * entries only register if {marketplace, plugin} is on this list. server:
 * entries always fail (schema is plugin-only). The
 * --dangerously-load-development-channels flag bypasses for both kinds.
 * Lives in GrowthBook so it can be updated without a release.
 *
 * Plugin-level granularity: if a plugin is approved, all its channel
 * servers are. Per-server gating was overengineering — a plugin that
 * sprouts a malicious second server is already compromised, and per-server
 * entries would break on harmless plugin refactors.
 *
 * The allowlist check is a pure {marketplace, plugin} comparison against
 * the user's typed tag. The gate's separate 'marketplace' step verifies
 * the tag matches what's actually installed before this check runs.
 */

import { z } from 'zod/v4'
import { getAllowedChannels } from '../../bootstrap/state.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

export type ChannelAllowlistEntry = {
  marketplace: string
  plugin: string
}

// Public preview plugins remain usable without a GrowthBook account/cache.
const DEFAULT_CHANNEL_ALLOWLIST: ChannelAllowlistEntry[] = [
  'telegram',
  'discord',
  'imessage',
  'fakechat',
].map(plugin => ({ marketplace: 'claude-plugins-official', plugin }))

const ChannelAllowlistSchema = lazySchema(() =>
  z.array(
    z.object({
      marketplace: z.string(),
      plugin: z.string(),
    }),
  ),
)

export function getChannelAllowlist(): ChannelAllowlistEntry[] {
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<unknown>(
    'tengu_harbor_ledger',
    DEFAULT_CHANNEL_ALLOWLIST,
  )
  const parsed = ChannelAllowlistSchema().safeParse(raw)
  return parsed.success ? parsed.data : []
}

/**
 * Overall channels on/off. Checked before any per-server gating —
 * when false, --channels is a no-op and no handlers register.
 * Local opt-out; availability does not depend on Anthropic rollout entitlements.
 */
export function isChannelsEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CHANNELS)
}

export function getEffectiveChannelAllowlist(
  orgList: ChannelAllowlistEntry[] | undefined,
): { entries: ChannelAllowlistEntry[]; source: 'org' | 'ledger' } {
  if (orgList !== undefined) return { entries: orgList, source: 'org' }
  return { entries: getChannelAllowlist(), source: 'ledger' }
}

/**
 * Pure allowlist check keyed off the connection's pluginSource — for UI
 * pre-filtering so the IDE only shows "Enable channel?" for servers that will
 * actually pass the gate. Not a security boundary: channel_enable still runs
 * the full gate. Matches the allowlist comparison inside gateChannelServer()
 * but standalone (no session/marketplace coupling — those are tautologies
 * when the entry is derived from pluginSource).
 *
 * Returns false for undefined pluginSource (non-plugin server — can never
 * match the {marketplace, plugin}-keyed ledger) and for @-less sources
 * (builtin/inline — same reason).
 */
export function isChannelAllowlisted(
  pluginSource: string | undefined,
): boolean {
  if (!pluginSource) return false
  const { name, marketplace } = parsePluginIdentifier(pluginSource)
  if (!marketplace) return false
  const { entries } = getEffectiveChannelAllowlist(
    getSettingsForSource('policySettings')?.allowedChannelPlugins,
  )
  return entries.some(e => e.plugin === name && e.marketplace === marketplace)
}

/**
 * Fork: an approved channel plugin's server (`plugin:<name>:<server>`) starts
 * only in a session that listed the plugin (--channels or channel_enable).
 * A bot token allows one poller, so the server of every other session
 * (claude web runs many) would take the bot from the session using it.
 */
export function isDeferredChannelServer(serverName: string): boolean {
  const [kind, plugin] = serverName.split(':')
  if (kind !== 'plugin' || !plugin || !isChannelsEnabled()) return false
  const { entries } = getEffectiveChannelAllowlist(
    getSettingsForSource('policySettings')?.allowedChannelPlugins,
  )
  if (!entries.some(e => e.plugin === plugin)) return false
  return !getAllowedChannels().some(
    c => c.kind === 'plugin' && c.name === plugin,
  )
}
