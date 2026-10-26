/**
 * `claude sandbox install|status` handlers for the native Windows sandbox.
 * Dynamically imported when `claude sandbox ...` runs.
 */

import {
  installWindowsSandboxAsync,
  resolveSrtWin,
} from '@anthropic-ai/sandbox-runtime'
import { errorMessage } from '../../utils/errors.js'
import { getPlatform } from '../../utils/platform.js'
import {
  getSrtWinPath,
  SandboxManager,
  WINDOWS_SANDBOX_USER,
} from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'

function unavailableReason(): string | undefined {
  if (getPlatform() !== 'windows') {
    return 'Windows sandbox install is only available on native Windows.'
  }
  if (!SandboxManager.isPlatformInEnabledList()) {
    return 'Sandboxing is disabled for this platform by the enabledPlatforms policy setting.'
  }
  if (!getSrtWinPath()) return 'srt-win.exe not found.'
  return undefined
}

/**
 * Provisions the sandbox user and its network filters (one UAC
 * prompt). Prints `{status, message}` and exits 0 only when status is "ok".
 */
export async function sandboxInstallHandler(): Promise<void> {
  const reason = unavailableReason()
  let result: { status: string; message: string }
  if (reason) {
    result = { status: 'unavailable', message: reason }
  } else if (SandboxManager.areSandboxSettingsLockedByPolicy()) {
    result = {
      status: 'unavailable',
      message:
        'Sandbox settings are locked by policy. Sandbox provisioning is managed by your administrator.',
    }
  } else {
    try {
      const installed = await installWindowsSandboxAsync({
        sandboxUser: WINDOWS_SANDBOX_USER,
        srtWin: resolveSrtWin({ path: getSrtWinPath()! }),
      })
      // A non-elevated caller cannot read the filters back ("cannot-read").
      result = installed.cancelled
        ? { status: 'cancelled', message: 'The UAC prompt was dismissed.' }
        : installed.user.provisioned &&
            installed.user.credPresent &&
            installed.wfp.state !== 'absent'
          ? { status: 'ok', message: 'The Windows sandbox is installed.' }
          : {
              status: 'error',
              message: `The install did not finish: ${jsonStringify(installed)}`,
            }
    } catch (error) {
      result = { status: 'error', message: errorMessage(error) }
    }
  }
  process.stdout.write(jsonStringify(result) + '\n')
  process.exit(result.status === 'ok' ? 0 : 1)
}

export function sandboxStatusHandler(): void {
  const reason = unavailableReason()
  const reasons = reason ? [reason] : SandboxManager.checkDependencies().errors
  process.stdout.write(
    jsonStringify({
      available: reason === undefined,
      installed: reason === undefined && reasons.length === 0,
      reasons,
      enabled: SandboxManager.isSandboxingEnabled(),
      unavailableReason: SandboxManager.getSandboxUnavailableReason() ?? null,
    }) + '\n',
  )
  process.exit(0)
}
