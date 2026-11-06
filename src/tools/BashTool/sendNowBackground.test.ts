import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}
const { setSessionSettingsCache } =
  await import('../../utils/settings/settingsCache.js')
setSessionSettingsCache({ settings: {}, errors: [] })
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { BashTool } = await import('./BashTool.js')
const { hasBackgroundRequestHandler, requestBackgroundForToolUse } =
  await import('../../tasks/LocalShellTask/LocalShellTask.js')

// Headless runs (claude web, SDK) register no foreground task, so send-now
// moves a running command by its tool_use id instead.
test.skipIf(process.platform === 'win32')('a running headless command moves to the background on request', async () => {
  const initial = getDefaultAppState()
  let state: AppState = {
    ...initial,
    toolPermissionContext: { ...initial.toolPermissionContext, mode: 'bypassPermissions' },
  }
  const context = {
    getAppState: () => state,
    setAppState: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
    abortController: new AbortController(),
    options: { isNonInteractiveSession: true },
    toolUseId: 'toolu_send_now',
  } as unknown as ToolUseContext
  const marker = join(mkdtempSync(join(tmpdir(), 'send-now-bg-')), 'started')
  const started = Date.now()
  const result = BashTool.call(
    { command: `touch '${marker}'; sleep 30`, timeout: 60_000 } as never,
    context,
  )
  while (!existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 20))
  expect(requestBackgroundForToolUse('toolu_send_now')).toBe(true)
  const { data } = await result
  expect(data.backgroundTaskId).toBeString()
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(hasBackgroundRequestHandler('toolu_send_now')).toBe(false)
  const task = state.tasks[data.backgroundTaskId!]
  expect(task?.toolUseId).toBe('toolu_send_now')
  ;(task as { shellCommand?: { kill: () => void } }).shellCommand?.kill()
})
