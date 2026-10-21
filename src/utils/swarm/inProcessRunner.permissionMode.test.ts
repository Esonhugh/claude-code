import { expect, test } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { AppState } from '../../state/AppState.js'
import type { PermissionMode } from '../../types/permissions.js'
import { getTeammateAppState } from './inProcessRunner.js'

function withTeammate(mode: PermissionMode, leader: Partial<AppState['toolPermissionContext']> = {}): AppState {
  const state = getDefaultAppState()
  return {
    ...state,
    toolPermissionContext: { ...state.toolPermissionContext, ...leader },
    tasks: { mate: { type: 'in_process_teammate', permissionMode: mode } as never },
  }
}

test('a teammate turn reads its own task mode on every call', () => {
  let state = withTeammate('default')
  const read = () => getTeammateAppState(state, 'mate', 'default').toolPermissionContext.mode
  expect(read()).toBe('default')
  state = { ...state, tasks: { mate: { ...state.tasks.mate!, permissionMode: 'bypassPermissions' } as never } }
  expect(read()).toBe('bypassPermissions')
  expect(state.toolPermissionContext.mode).toBe('default')
})

test('a teammate in auto does not inherit the leader\'s classifier-bypassing allow rules', () => {
  const state = withTeammate('auto', { alwaysAllowRules: { session: ['Bash'] } })
  const view = getTeammateAppState(state, 'mate', 'default')
  expect(view.toolPermissionContext.mode).toBe('auto')
  expect(view.toolPermissionContext.alwaysAllowRules.session ?? []).not.toContain('Bash')
  expect(state.toolPermissionContext.alwaysAllowRules.session).toEqual(['Bash'])
  expect(getTeammateAppState(state, 'mate', 'default').toolPermissionContext).toBe(view.toolPermissionContext)
})

test('a teammate leaving auto gets the leader\'s stripped rules back', () => {
  const state = withTeammate('default', {
    mode: 'auto',
    alwaysAllowRules: { session: [] },
    strippedDangerousRules: { session: ['Bash'] },
  })
  const view = getTeammateAppState(state, 'mate', 'default').toolPermissionContext
  expect(view.mode).toBe('default')
  expect(view.alwaysAllowRules.session).toContain('Bash')
})

test('a teammate whose task is gone keeps the mode its turn started in', () => {
  const state = { ...withTeammate('default'), tasks: {} }
  expect(getTeammateAppState(state, 'mate', 'acceptEdits').toolPermissionContext.mode).toBe('acceptEdits')
})
