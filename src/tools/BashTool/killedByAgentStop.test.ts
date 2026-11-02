import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'

;(globalThis as typeof globalThis & { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}
const { setSessionSettingsCache } =
  await import('../../utils/settings/settingsCache.js')
setSessionSettingsCache({ settings: {}, errors: [] })
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { BashTool } = await import('./BashTool.js')
const { ShellError } = await import('../../utils/errors.js')

function context(abortController: AbortController) {
  const initial = getDefaultAppState()
  const state = {
    ...initial,
    toolPermissionContext: {
      ...initial.toolPermissionContext,
      mode: 'bypassPermissions' as const,
    },
  }
  return {
    getAppState: () => state,
    setAppState: () => {},
    abortController,
    options: { isNonInteractiveSession: true },
  } as unknown as ToolUseContext
}

// Official marks a killed command as interrupted only for a user or shutdown
// abort reason. An agent stopped at exit aborts without one, so its shell's
// error keeps the plain `Exit code 137` plus output, with no interrupt line.
test.skipIf(process.platform === 'win32').each([
  [undefined, false],
  ['user-cancel', true],
] as const)('abort reason %p marks the killed shell interrupted: %p', async (reason, interrupted) => {
  const abortController = new AbortController()
  // Abort once the command is running; a fixed delay can fire before the
  // shell starts on a loaded machine.
  const marker = join(mkdtempSync(join(tmpdir(), 'killed-by-stop-')), 'started')
  const failure = BashTool.call(
    { command: `echo HOLD_START; touch '${marker}'; sleep 30`, timeout: 60_000 } as never,
    context(abortController),
  )
  while (!existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 20))
  abortController.abort(reason)
  await expect(failure).rejects.toBeInstanceOf(ShellError)
  const error = (await failure.catch(e => e)) as InstanceType<typeof ShellError>
  expect(error.code).toBe(137)
  expect(error.interrupted).toBe(interrupted)
  expect(error.stderr).toContain('HOLD_START')
})
