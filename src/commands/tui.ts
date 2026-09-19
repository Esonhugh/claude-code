import type { Command, LocalJSXCommandCall } from '../types/command.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import {
  createCommandInputMessage,
  formatCommandInputTags,
} from '../utils/messages.js'
import {
  getFullscreenModeSource,
  isFullscreenEnvEnabled,
  isMouseClicksDisabled,
  isMouseTrackingEnabled,
  isTmuxControlMode,
} from '../utils/fullscreen.js'

const usage =
  'Usage: /tui [status|fullscreen|default]\nSwitch with /tui fullscreen or /tui default.'

const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const mode = args.trim().toLowerCase()
  if (mode && !['status', 'fullscreen', 'default'].includes(mode)) {
    onDone(`Unknown TUI mode. ${usage}`, { display: 'system' })
    return null
  }
  const fullscreen = isFullscreenEnvEnabled()
  const env = process.env.CLAUDE_CODE_NO_FLICKER
  if (
    (mode === 'fullscreen' || mode === 'default') &&
    (isEnvTruthy(env) || isEnvDefinedFalsy(env)) &&
    (mode === 'fullscreen') !== fullscreen
  ) {
    onDone(
      'Cannot switch: CLAUDE_CODE_NO_FLICKER overrides the tui setting. Restart with that variable unset, then use /tui again.',
      { display: 'system' },
    )
    return null
  }
  if (mode === 'fullscreen' || mode === 'default') {
    const { canRestartTui, restartTui } = await import('../utils/tuiRestart.js')
    const changing = (mode === 'fullscreen') !== fullscreen
    if (
      changing &&
      Object.values(context.getAppState().tasks).some(
        (task) => task.status === 'running',
      )
    ) {
      onDone(
        'Cannot switch while background tasks are running. Finish or stop them before restarting the TUI.',
        { display: 'system' },
      )
      return null
    }
    const { error } = updateSettingsForSource('userSettings', { tui: mode })
    if (error) {
      onDone(
        `Could not save TUI setting: ${error.message}. Renderer unchanged.`,
        { display: 'system' },
      )
      return null
    }
    if (getInitialSettings().tui !== mode) {
      onDone(
        `Saved tui: ${mode} in user settings, but a higher-priority setting or --setting-sources overrides it. Renderer unchanged. Check project/local/--settings/managed settings.`,
        { display: 'system' },
      )
      return null
    }
    if (!changing) {
      onDone(
        `TUI renderer is already ${mode}. Saved as your default for future sessions.`,
        { display: 'system' },
      )
      return null
    }
    if (!canRestartTui()) {
      onDone(
        `Saved tui: ${mode}. Automatic restart is unavailable in this runtime; exit and relaunch with --continue to apply it. Renderer unchanged.`,
        { display: 'system' },
      )
      return null
    }
    try {
      await restartTui([
        ...context.messages,
        createCommandInputMessage(formatCommandInputTags('tui', args)),
      ])
    } catch (error) {
      onDone(
        `Saved tui: ${mode}, but restart failed: ${error instanceof Error ? error.message : String(error)}. Current renderer unchanged. Finish this session, then relaunch to apply the setting.`,
        { display: 'system' },
      )
    }
    return null
  }
  const source = getFullscreenModeSource()
  const mouse =
    !fullscreen || !isMouseTrackingEnabled()
      ? 'off'
      : isMouseClicksDisabled()
        ? 'scroll only'
        : 'full'
  onDone(
    [
      `TUI renderer: ${fullscreen ? 'fullscreen' : 'default'}`,
      `Source: ${source}`,
      `Version: ${MACRO.VERSION}${MACRO.BUILD_TIME ? ` (built ${MACRO.BUILD_TIME})` : ''}`,
      `Terminal: ${process.stdout.columns ?? 'unknown'} columns × ${process.stdout.rows ?? 'unknown'} rows`,
      `TTY: stdin ${process.stdin.isTTY ? 'yes' : 'no'}, stdout ${process.stdout.isTTY ? 'yes' : 'no'}`,
      `tmux: ${process.env.TMUX ? 'yes' : 'no'}; control mode: ${isTmuxControlMode() ? 'yes' : 'no'}`,
      `Mouse: ${mouse}`,
      `CLAUDE_CODE_DISABLE_MOUSE: ${isMouseTrackingEnabled() ? 'off' : 'on'}`,
      `CLAUDE_CODE_DISABLE_MOUSE_CLICKS: ${isMouseClicksDisabled() ? 'on' : 'off'}`,
      usage,
    ].join('\n'),
    { display: 'system' },
  )
  return null
}

export default {
  type: 'local-jsx',
  name: 'tui',
  description:
    'Inspect or switch the terminal UI renderer (default | fullscreen)',
  argumentHint: '[status|default|fullscreen]',
  load: () => Promise.resolve({ call }),
} satisfies Command
