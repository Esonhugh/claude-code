import { expect, test } from 'bun:test'
import type { AppState } from '../state/AppState.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import {
  getCoordinatorSessionRows,
  getCoordinatorTaskAtIndex,
  getCoordinatorTaskCount,
  getCoordinatorTaskIndex,
} from './CoordinatorAgentStatusRows.js'

function teammate(name: string, startTime: number, overrides: Partial<InProcessTeammateTaskState> = {}): InProcessTeammateTaskState {
  return {
    id: `${name}@team`, type: 'in_process_teammate', status: 'running',
    description: `${name} work`, startTime, outputFile: '', outputOffset: 0, notified: false,
    identity: { agentId: `${name}@team`, agentName: name, teamName: 'team', color: 'green', planModeRequired: false, parentSessionId: 's' },
    prompt: 'work', awaitingPlanApproval: false, permissionMode: 'default',
    pendingUserMessages: [], isIdle: false, shutdownRequested: false,
    lastReportedToolCount: 0, lastReportedTokenCount: 0,
    progress: { tokenCount: 1200, toolUseCount: 1 },
    ...overrides,
  } as InProcessTeammateTaskState
}

const agent = {
  id: 'agent-1', type: 'local_agent', status: 'running', agentId: 'agent-1',
  agentType: 'Explore', description: 'Read source', startTime: 1_500,
  progress: { tokenCount: 10, toolUseCount: 0 },
}

function tasksOf(...list: object[]): AppState['tasks'] {
  return Object.fromEntries(list.map(t => [(t as { id: string }).id, t])) as unknown as AppState['tasks']
}

test('in-process teammates share the panel with agents, ordered by start time', () => {
  const tasks = tasksOf(
    teammate('busy', 1_000),
    agent,
    teammate('idler', 2_000, { isIdle: true }),
    teammate('planner', 3_000, { awaitingPlanApproval: true, pendingUserMessages: ['a', 'b'] }),
  )
  const rows = getCoordinatorSessionRows({ tasks, now: 6_000 })
  expect(rows.map(row => [row.kind, row.primaryText])).toEqual([
    ['main', 'main'],
    ['teammate', 'busy'],
    ['agent', 'Explore'],
    ['teammate', 'idler'],
    ['teammate', 'planner'],
  ])
  expect(rows[1]).toMatchObject({ secondaryText: 'busy work', elapsed: '5s', tokens: '1.2k tokens', color: 'green_FOR_SUBAGENTS_ONLY' })
  expect(rows[3]).toMatchObject({ elapsed: 'idle', tokens: '' })
  expect(rows[4]).toMatchObject({ elapsed: 'awaiting approval · 2 queued', tokens: '' })
  expect(getCoordinatorTaskAtIndex(tasks, 1)?.id).toBe('busy@team')
})

const idleTeam = tasksOf(
  teammate('a', 1_000, { isIdle: true }),
  teammate('b', 2_000, { isIdle: true }),
  teammate('busy', 2_500),
  teammate('c', 3_000, { isIdle: true }),
  teammate('d', 4_000, { isIdle: true }),
  teammate('e', 5_000, { isIdle: true }),
)

test('idle teammates beyond three collapse into one idle summary row', () => {
  const rows = getCoordinatorSessionRows({ tasks: idleTeam, now: 6_000 })
  expect(rows.map(row => row.primaryText)).toEqual(['main', 'a', 'b', 'busy', 'c', '2 idle agents'])
  expect(rows[5]?.kind).toBe('idle_summary')
  expect(getCoordinatorTaskCount(idleTeam)).toBe(6)
  expect(getCoordinatorTaskAtIndex(idleTeam, 5)).toEqual({ type: 'idle_summary', id: 'idle-teammate-summary', taskIds: ['d@team', 'e@team'] })
  expect(getCoordinatorTaskIndex(idleTeam, 'e@team')).toBe(5)
})

test('expanded idle teammates and the viewed teammate are never collapsed', () => {
  const expanded = getCoordinatorSessionRows({ tasks: idleTeam, now: 6_000, idleTeammatesExpanded: true })
  expect(expanded.map(row => row.primaryText)).toEqual(['main', 'a', 'b', 'busy', 'c', 'd', 'e'])
  expect(getCoordinatorTaskIndex(idleTeam, 'e@team', undefined, true)).toBe(6)
  const viewed = getCoordinatorSessionRows({ tasks: idleTeam, now: 6_000, viewingAgentTaskId: 'a@team' })
  expect(viewed.map(row => row.primaryText)).toEqual(['main', 'a', 'b', 'busy', 'c', 'd', '1 idle agent'])
})

test('terminal teammates keep a frozen clock and an explicit status', () => {
  const rows = getCoordinatorSessionRows({
    tasks: tasksOf(teammate('done', 1_000, { status: 'completed', endTime: 6_000, retain: true, isIdle: true })),
    now: 60_000,
  })
  expect(rows[1]).toMatchObject({ elapsed: '5s', statusText: 'completed' })
})
