import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, spyOn } from 'bun:test'
import type * as React from 'react'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { AppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import * as permissionSetup from '../../utils/permissions/permissionSetup.js'
import * as settings from '../../utils/settings/settings.js'
import { call } from './yolo.js'

type ModeChange = { success: true } | { success: false; error: string }

function createContext(
  requestPermissionModeChange?: (
    mode: string,
    state: { appState: AppState },
  ) => Promise<ModeChange>,
) {
  const state = {
    appState: {
      toolPermissionContext: getEmptyToolPermissionContext(),
    } as AppState,
  }
  const requested: string[] = []
  const context = {
    getAppState: () => state.appState,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state.appState = updater(state.appState)
    },
    requestPermissionModeChange: async (mode: string) => {
      requested.push(mode)
      if (requestPermissionModeChange) {
        return requestPermissionModeChange(mode, state)
      }
      // Mirrors the REPL plus applyPermissionUpdate ignoring setMode bypass
      // while bypass is unavailable.
      const permission = state.appState.toolPermissionContext
      if (permission.isBypassPermissionsModeAvailable) {
        state.appState = {
          ...state.appState,
          toolPermissionContext: { ...permission, mode: mode as 'bypassPermissions' },
        }
      }
      return { success: true }
    },
  } as unknown as LocalJSXCommandContext
  return { context, state, requested }
}

async function run(context: LocalJSXCommandContext) {
  let output: string | undefined
  const node = await call(result => {
    output = result
  }, context)
  return { node, output: () => output }
}

describe('/yolo', () => {
  let disabled: ReturnType<typeof spyOn>
  let consented: ReturnType<typeof spyOn>

  beforeEach(() => {
    disabled = spyOn(permissionSetup, 'isBypassPermissionsModeDisabled').mockReturnValue(false)
    consented = spyOn(settings, 'hasSkipDangerousModePermissionPrompt').mockReturnValue(true)
  })

  afterEach(() => {
    disabled.mockRestore()
    consented.mockRestore()
  })

  it('does not switch when bypass is disabled by settings or policy', async () => {
    disabled.mockReturnValue(true)
    const { context, state, requested } = createContext()

    const { node, output } = await run(context)

    assert.equal(node, null)
    assert.deepEqual(requested, [])
    assert.equal(state.appState.toolPermissionContext.mode, 'default')
    assert.equal(state.appState.toolPermissionContext.isBypassPermissionsModeAvailable, false)
    assert.equal(
      output(),
      'Bypass permissions mode was not enabled: it is disabled by settings or configuration',
    )
  })

  it('switches after an earlier bypass opt-in and makes bypass available', async () => {
    const { context, state, requested } = createContext()

    const { node, output } = await run(context)

    assert.equal(node, null)
    assert.deepEqual(requested, ['bypassPermissions'])
    assert.equal(state.appState.toolPermissionContext.mode, 'bypassPermissions')
    assert.equal(state.appState.toolPermissionContext.isBypassPermissionsModeAvailable, true)
    assert.equal(output(), 'Bypass permissions mode enabled')
  })

  it('shows the bypass dialog first and switches only after it is accepted', async () => {
    consented.mockReturnValue(false)
    const { context, state, requested } = createContext()

    const { node, output } = await run(context)
    const dialog = node as React.ReactElement<{ onAccept(): void }>

    assert.ok(dialog)
    assert.deepEqual(requested, [])
    assert.equal(output(), undefined)
    assert.equal(state.appState.toolPermissionContext.isBypassPermissionsModeAvailable, false)

    dialog.props.onAccept()
    await new Promise(resolve => setTimeout(resolve, 0))

    assert.deepEqual(requested, ['bypassPermissions'])
    assert.equal(state.appState.toolPermissionContext.mode, 'bypassPermissions')
    assert.equal(output(), 'Bypass permissions mode enabled')
  })

  it('leaves the mode unchanged when the bypass dialog is declined', async () => {
    consented.mockReturnValue(false)
    const { context, state, requested } = createContext()

    const { node, output } = await run(context)
    ;(node as React.ReactElement<{ onDecline(): void }>).props.onDecline()

    assert.deepEqual(requested, [])
    assert.equal(state.appState.toolPermissionContext.mode, 'default')
    assert.equal(state.appState.toolPermissionContext.isBypassPermissionsModeAvailable, false)
    assert.equal(output(), 'Bypass permissions mode was not enabled')
  })

  it('reports rejection and does not leave bypass available', async () => {
    const { context, state } = createContext(async () => ({
      success: false,
      error: 'permission opt-in is required',
    }))

    const { output } = await run(context)

    assert.equal(
      output(),
      'Bypass permissions mode was not enabled: permission opt-in is required',
    )
    assert.equal(state.appState.toolPermissionContext.isBypassPermissionsModeAvailable, false)
  })

  it('does not claim success when the mode did not actually change', async () => {
    const { context, state } = createContext(async () => ({ success: true }))

    const { output } = await run(context)

    assert.equal(
      output(),
      'Bypass permissions mode was not enabled: the permission mode did not change',
    )
    assert.equal(state.appState.toolPermissionContext.mode, 'default')
    assert.equal(state.appState.toolPermissionContext.isBypassPermissionsModeAvailable, false)
  })
})
