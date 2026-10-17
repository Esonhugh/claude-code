import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configDir = await mkdtemp(join(tmpdir(), 'teammate-shutdown-'))
process.env.CLAUDE_CONFIG_DIR = configDir
afterAll(async () => {
  await rm(configDir, { recursive: true, force: true })
})

const { setIsInteractive } = await import('../../bootstrap/state.js')
const { createTaskStateBase } = await import('../../Task.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { drainSdkEvents } = await import('../sdkEventQueue.js')
const { PANEL_GRACE_MS } = await import('../task/framework.js')
const { createTask, getTask } = await import('../tasks.js')
const { readTeamFileAsync, writeTeamFileAsync } = await import('./teamHelpers.js')
const { handleTeammateShutdownApproved } = await import('./teammateShutdown.js')

import type { AppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'

const TEAM = 'shutdown-team'
const RESEARCHER = `researcher@${TEAM}`

function teammateTask(id: string, agentId: string): InProcessTeammateTaskState {
  const [agentName = '', teamName = ''] = agentId.split('@')
  return {
    ...createTaskStateBase(id, 'in_process_teammate', agentName, `toolu_${id}`),
    type: 'in_process_teammate',
    status: 'running',
    identity: { agentId, agentName, teamName, planModeRequired: false, parentSessionId: 'session' },
    prompt: 'inspect only',
    awaitingPlanApproval: false,
    permissionMode: 'default',
    pendingUserMessages: [],
    isIdle: false,
    shutdownRequested: true,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  }
}

function teammateEntry(name: string) {
  return { name, tmuxSessionName: 'in-process', tmuxPaneId: 'in-process', cwd: '/tmp', spawnedAt: 1 }
}

test('shutdown approval removes the teammate everywhere and ends its in-process task', async () => {
  setIsInteractive(false)
  drainSdkEvents()
  await writeTeamFileAsync(TEAM, {
    name: TEAM,
    createdAt: 1,
    leadAgentId: `team-lead@${TEAM}`,
    members: ['team-lead', 'researcher', 'writer'].map(name => ({
      agentId: `${name}@${TEAM}`,
      name,
      joinedAt: 1,
      tmuxPaneId: 'in-process',
      cwd: '/tmp',
      subscriptions: [],
    })),
  })
  const ownedTaskId = await createTask(TEAM, {
    subject: 'Investigate',
    description: 'd',
    owner: 'researcher',
    status: 'in_progress',
    blocks: [],
    blockedBy: [],
  })

  let state: AppState = {
    ...getDefaultAppState(),
    tasks: { t1: teammateTask('t1', RESEARCHER), t2: teammateTask('t2', `writer@${TEAM}`) },
    teamContext: {
      teamName: TEAM,
      teamFilePath: '',
      leadAgentId: `team-lead@${TEAM}`,
      teammates: { [RESEARCHER]: teammateEntry('researcher'), [`writer@${TEAM}`]: teammateEntry('writer') },
    },
  }
  const setAppState = (f: (prev: AppState) => AppState) => {
    state = f(state)
  }

  const before = Date.now()
  const result = await handleTeammateShutdownApproved({
    teamName: TEAM,
    teammateId: RESEARCHER,
    teammateName: 'researcher',
    setAppState,
  })

  expect(result.removed).toBe(true)
  expect(result.notificationMessage).toContain('researcher has shut down.')
  expect(result.notificationMessage).toContain(`#${ownedTaskId} "Investigate"`)
  const ownedTask = await getTask(TEAM, ownedTaskId)
  expect(ownedTask?.owner).toBeUndefined()
  expect(ownedTask?.status).toBe('pending')
  expect((await readTeamFileAsync(TEAM))!.members.map(m => m.name)).toEqual(['team-lead', 'writer'])
  expect(Object.keys(state.teamContext!.teammates)).toEqual([`writer@${TEAM}`])

  const t1 = state.tasks.t1 as InProcessTeammateTaskState
  expect(t1).toMatchObject({ status: 'completed', notified: true, retain: false })
  expect(t1.evictAfter! - t1.endTime!).toBe(PANEL_GRACE_MS)
  expect(t1.endTime!).toBeGreaterThanOrEqual(before)
  expect(state.tasks.t2!.status).toBe('running')
  expect(drainSdkEvents()).toEqual([
    expect.objectContaining({ subtype: 'task_notification', task_id: 't1', tool_use_id: 'toolu_t1', status: 'completed' }),
  ])

  // A second approval for the same teammate (e.g. seen by another poller) is a no-op.
  const again = await handleTeammateShutdownApproved({
    teamName: TEAM,
    teammateId: RESEARCHER,
    teammateName: 'researcher',
    setAppState,
  })
  expect(again.removed).toBe(false)
  expect(drainSdkEvents()).toEqual([])
})
