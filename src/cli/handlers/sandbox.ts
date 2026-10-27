/**
 * `claude sandbox install|status` handlers for the native Windows sandbox,
 * and `claude edit-sandbox-settings` for the VS Code extension's sandbox
 * dialog. Dynamically imported when those commands run.
 */

import {
  installWindowsSandboxAsync,
  resolveSrtWin,
} from '@anthropic-ai/sandbox-runtime'
import { z } from 'zod/v4'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { getPlatform } from '../../utils/platform.js'
import {
  getSrtWinPath,
  isSandboxMandated,
  isUnsandboxedFallbackClosedByTrustedSource,
  SandboxManager,
  WINDOWS_SANDBOX_USER,
} from '../../utils/sandbox/sandbox-adapter.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
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

const SandboxSettingsEditSchema = z
  .strictObject({
    mode: z.enum(['auto-allow', 'regular', 'disabled']).optional(),
    allowUnsandboxedCommands: z.boolean().optional(),
    excludeCommand: z.string().trim().min(1).max(1000).optional(),
  })
  .refine(
    edit =>
      edit.mode !== undefined ||
      edit.allowUnsandboxedCommands !== undefined ||
      edit.excludeCommand !== undefined,
    {
      error:
        'Nothing to change: none of mode, allowUnsandboxedCommands or excludeCommand was given.',
    },
  )

type SandboxSettingsEdit = z.infer<typeof SandboxSettingsEditSchema>

function stripQuotes(pattern: string): string {
  return pattern.replace(/^["']|["']$/g, '').trim()
}

/**
 * Applies one edit from the VS Code extension's sandbox dialog, with the
 * checks the terminal's /sandbox dialog makes, then reads the settings back.
 */
export async function runSandboxSettingsEdit(
  input: unknown,
): Promise<
  { ok: true; written: SandboxSettingsEdit } | { ok: false; error: string }
> {
  const parsed = SandboxSettingsEditSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: issue
        ? `Not a sandbox settings edit (${issue.path.map(String).join('.') || 'edit'}: ${issue.message}).`
        : 'Not a sandbox settings edit.',
    }
  }
  const edit = parsed.data
  if (
    !SandboxManager.isSupportedPlatform() ||
    !SandboxManager.isPlatformInEnabledList()
  ) {
    return { ok: false, error: 'Sandboxing is not available on this platform.' }
  }
  if (SandboxManager.areSandboxSettingsLockedByPolicy()) {
    return {
      ok: false,
      error:
        'Sandbox settings are set by a higher-priority configuration and cannot be changed here.',
    }
  }
  if (edit.mode !== undefined && edit.mode !== 'disabled') {
    const { errors } = SandboxManager.checkDependencies()
    if (errors.length > 0) {
      return {
        ok: false,
        error: `The sandbox cannot run on this machine yet: ${errors.join('; ')}`,
      }
    }
  }
  if (
    edit.allowUnsandboxedCommands !== undefined &&
    isUnsandboxedFallbackClosedByTrustedSource()
  ) {
    return {
      ok: false,
      error:
        'The unsandboxed fallback is set by a higher-priority configuration and cannot be changed here.',
    }
  }

  let source: 'localSettings' | 'userSettings' = 'localSettings'
  if (edit.mode !== undefined) {
    await SandboxManager.setSandboxSettings({
      enabled: edit.mode !== 'disabled',
      autoAllowBashIfSandboxed: edit.mode === 'auto-allow',
    })
  }
  if (edit.allowUnsandboxedCommands !== undefined) {
    await SandboxManager.setSandboxSettings({
      allowUnsandboxedCommands: edit.allowUnsandboxedCommands,
    })
  }
  if (edit.excludeCommand !== undefined) {
    const pattern = stripQuotes(edit.excludeCommand)
    if (pattern === '') {
      return { ok: false, error: 'The command pattern is empty.' }
    }
    // A mandated sandbox only honors exclusions from trusted settings.
    if (isSandboxMandated()) {
      if (!isSettingSourceEnabled('userSettings')) {
        return {
          ok: false,
          error:
            "This session's sandbox policy limits exclusions to trusted settings (managed policy, a --settings file, user settings), and user settings are turned off here (--setting-sources), so there is no settings file where the exclusion would take effect. Re-enable user settings, or add it to the managed or --settings configuration.",
        }
      }
      source = 'userSettings'
    }
    const sandbox = getSettingsForSource(source)?.sandbox
    const excluded = sandbox?.excludedCommands ?? []
    if (!excluded.includes(pattern)) {
      updateSettingsForSource(source, {
        sandbox: { ...sandbox, excludedCommands: [...excluded, pattern] },
      })
    }
  }

  const landed =
    (edit.mode === undefined ||
      (edit.mode === 'disabled'
        ? !SandboxManager.isSandboxEnabledInSettings()
        : SandboxManager.isSandboxEnabledInSettings() &&
          (edit.mode === 'auto-allow') ===
            SandboxManager.isAutoAllowBashIfSandboxedEnabled())) &&
    (edit.allowUnsandboxedCommands === undefined ||
      SandboxManager.areUnsandboxedCommandsAllowed() ===
        edit.allowUnsandboxedCommands) &&
    (edit.excludeCommand === undefined ||
      SandboxManager.getExcludedCommands().includes(
        stripQuotes(edit.excludeCommand),
      ))
  if (!landed) {
    return {
      ok: false,
      error: `The settings file could not be updated. Check that ${source === 'userSettings' ? '~/.claude/settings.json' : "the project's .claude/settings.local.json"} can be written.`,
    }
  }
  return { ok: true, written: edit }
}

const MAX_EDIT_BYTES = 4096

async function readStdinLimited(): Promise<string | null> {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.length > MAX_EDIT_BYTES) return null
  }
  return text
}

/** `claude edit-sandbox-settings --json`, run by the VS Code extension. */
export async function sandboxSettingsEditHandler(): Promise<void> {
  const fail = (message: string): never => {
    process.stderr.write(message + '\n')
    process.exit(1)
  }
  if (process.stdin.isTTY) {
    fail(
      'claude edit-sandbox-settings reads one JSON edit from stdin; it is run by the VS Code extension, not by hand',
    )
  }
  if (process.env.CLAUDE_CODE_CHILD_SESSION) {
    fail(
      'This setting cannot be changed from an editor started inside a Claude Code session. Start the editor outside the session and try again.',
    )
  }
  process.stdin.setEncoding('utf8')
  const input = safeParseJSON(await readStdinLimited(), false)
  if (input === null) fail('claude edit-sandbox-settings: stdin is not a JSON edit')
  const result = await runSandboxSettingsEdit(input)
  if ('error' in result) fail(result.error)
  process.stdout.write(jsonStringify(result) + '\n')
  process.exit(0)
}
