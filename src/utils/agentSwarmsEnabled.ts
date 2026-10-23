import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isEnvDefinedFalsy } from './envUtils.js'
import { isAnt } from 'src/utils/userType.js'


/**
 * Check if --agent-teams flag is provided via CLI.
 * Checks process.argv directly to avoid import cycles with bootstrap/state.
 * Note: The flag is only shown in help for ant users, but if external users
 * pass it anyway, it will work (subject to the killswitch).
 */
function isAgentTeamsFlagSet(): boolean {
  return process.argv.includes('--agent-teams')
}

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * Ant builds: always enabled.
 * External builds: on by default (official needs CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1;
 * this build does not). CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0 turns them off unless
 * --agent-teams is passed. The GrowthBook killswitch 'tengu_amber_flint' still applies.
 */
export function isAgentSwarmsEnabled(): boolean {
  // Ant: always on
  if (isAnt()) {
    return true
  }

  // External: on unless explicitly turned off
  if (
    isEnvDefinedFalsy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  // Killswitch — always respected for external users
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}
