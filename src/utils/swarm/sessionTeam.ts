import { rename } from 'fs/promises'
import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppStateStore.js'
import { formatAgentId } from '../agentId.js'
import { getCwd } from '../cwd.js'
import { ensureTasksDir, getTasksDir, setLeaderTeamName } from '../tasks.js'
import { TEAM_LEAD_NAME } from './constants.js'
import {
  getTeamFilePath,
  readTeamFileAsync,
  registerTeamForSessionCleanup,
  type TeamFile,
  writeTeamFileAsync,
} from './teamHelpers.js'
import { assignTeammateColor } from './teammateLayoutManager.js'

export function getSessionTeamName(sessionId: string = getSessionId()): string {
  return `session-${sessionId.slice(0, 8)}`
}

/**
 * The leader's implicit team. Official 2.1.311 has no TeamCreate: an Agent
 * call with `name` joins the session team `session-<id>`, which is created on
 * first use. Returns the team name; a leader that already has a team keeps it.
 */
export async function ensureSessionTeam(
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
): Promise<string> {
  const existing = getAppState().teamContext?.teamName
  if (existing) return existing

  const teamName = getSessionTeamName()
  const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName)
  if (!(await readTeamFileAsync(teamName))) {
    const teamFile: TeamFile = {
      name: teamName,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: getSessionId(),
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: TEAM_LEAD_NAME,
          joinedAt: Date.now(),
          tmuxPaneId: 'leader',
          cwd: getCwd(),
          subscriptions: [],
          backendType: 'in-process',
        },
      ],
    }
    await writeTeamFileAsync(teamName, teamFile)
  }
  registerTeamForSessionCleanup(teamName)

  // Tasks created before the team existed live under the session id; move
  // them so the leader and its teammates keep sharing one list.
  await rename(getTasksDir(getSessionId()), getTasksDir(teamName)).catch(
    () => {},
  )
  await ensureTasksDir(teamName)
  setLeaderTeamName(teamName)

  setAppState(prev => ({
    ...prev,
    teamContext: {
      teamName,
      teamFilePath: getTeamFilePath(teamName),
      leadAgentId,
      teammates: {
        [leadAgentId]: {
          name: TEAM_LEAD_NAME,
          agentType: TEAM_LEAD_NAME,
          color: assignTeammateColor(leadAgentId),
          tmuxSessionName: 'in-process',
          tmuxPaneId: 'leader',
          cwd: getCwd(),
          spawnedAt: Date.now(),
        },
      },
    },
  }))
  return teamName
}
