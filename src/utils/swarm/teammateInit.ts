/**
 * Teammate Initialization Module
 *
 * Handles initialization for Claude Code instances running as teammates in a swarm.
 * Registers a Stop hook to notify the team leader when the teammate becomes idle.
 */

import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import { addFunctionHook } from '../hooks/sessionHooks.js'
import { applyPermissionUpdate } from '../permissions/PermissionUpdate.js'
import { jsonStringify } from '../slowOperations.js'
import { getTeammateColor } from '../teammate.js'
import {
  createIdleNotification,
  getIdleResult,
  getLastPeerDmSummary,
  getTurnFailureReason,
  writeToMailbox,
} from '../teammateMailbox.js'
import { readTeamFile, setMemberActive } from './teamHelpers.js'

let failedTurnTarget:
  | { teamName: string; agentName: string; leadAgentName: string }
  | undefined

/**
 * Initializes hooks for a teammate running in a swarm.
 * Should be called early in session startup after AppState is available.
 *
 * Registers a Stop hook that sends an idle notification to the team leader
 * when this teammate's session stops.
 */
export function initializeTeammateHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  teamInfo: { teamName: string; agentId: string; agentName: string },
): void {
  const { teamName, agentId, agentName } = teamInfo

  // Read team file to get leader ID
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logForDebugging(`[TeammateInit] Team file not found for team: ${teamName}`)
    return
  }

  const leadAgentId = teamFile.leadAgentId

  // Apply team-wide allowed paths if any exist
  if (teamFile.teamAllowedPaths && teamFile.teamAllowedPaths.length > 0) {
    logForDebugging(
      `[TeammateInit] Found ${teamFile.teamAllowedPaths.length} team-wide allowed path(s)`,
    )

    for (const allowedPath of teamFile.teamAllowedPaths) {
      // For absolute paths (starting with /), prepend one / to create //path/** pattern
      // For relative paths, just use path/**
      const ruleContent = allowedPath.path.startsWith('/')
        ? `/${allowedPath.path}/**`
        : `${allowedPath.path}/**`

      logForDebugging(
        `[TeammateInit] Applying team permission: ${allowedPath.toolName} allowed in ${allowedPath.path} (rule: ${ruleContent})`,
      )

      setAppState(prev => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdate(
          prev.toolPermissionContext,
          {
            type: 'addRules',
            rules: [
              {
                toolName: allowedPath.toolName,
                ruleContent,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ),
      }))
    }
  }

  // Find the leader's name from the members array
  const leadMember = teamFile.members.find(m => m.agentId === leadAgentId)
  const leadAgentName = leadMember?.name || 'team-lead'

  // Don't register hook if this agent is the leader
  if (agentId === leadAgentId) {
    logForDebugging(
      '[TeammateInit] This agent is the team leader - skipping idle notification hook',
    )
    return
  }

  failedTurnTarget = { teamName, agentName, leadAgentName }

  logForDebugging(
    `[TeammateInit] Registering Stop hook for teammate ${agentName} to notify leader ${leadAgentName}`,
  )

  // Register Stop hook to notify leader when this teammate stops
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // No matcher - applies to all Stop events
    async (messages, _signal) => {
      // Mark this teammate as idle in the team config (fire and forget)
      void setMemberActive(teamName, agentName, false)

      // Send idle notification to the team leader using agent name (not UUID)
      // Must await to ensure the write completes before process shutdown
      const notification = createIdleNotification(agentName, {
        idleReason: 'available',
        summary: getLastPeerDmSummary(messages),
        result: getIdleResult(messages),
      })
      await writeToMailbox(leadAgentName, {
        from: agentName,
        text: jsonStringify(notification),
        timestamp: new Date().toISOString(),
        color: getTeammateColor(),
      })
      logForDebugging(
        `[TeammateInit] Sent idle notification to leader ${leadAgentName}`,
      )
      return true // Don't block the Stop
    },
    'Failed to send idle notification to team leader',
    {
      timeout: 10000,
    },
  )
}

/**
 * Stop hooks are skipped when a turn ends on an API error, so a pane teammate
 * reports that turn to its leader here, at REPL turn end, as a failed idle
 * notification (official 2.1.319).
 */
export async function notifyLeaderOfFailedTurn(
  messages: Message[],
  aborted: boolean,
): Promise<void> {
  if (!failedTurnTarget || aborted) return
  const failureReason = getTurnFailureReason(messages)
  if (failureReason === undefined) return
  const { teamName, agentName, leadAgentName } = failedTurnTarget
  void setMemberActive(teamName, agentName, false)
  const notification = createIdleNotification(agentName, {
    idleReason: 'failed',
    failureReason,
    summary: getLastPeerDmSummary(messages),
    result: getIdleResult(messages),
  })
  await writeToMailbox(
    leadAgentName,
    {
      from: agentName,
      text: jsonStringify(notification),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )
}
