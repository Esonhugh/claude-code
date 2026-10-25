import type { LocalJSXCommandCall } from '../../types/command.js'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  FOCUS_NEEDS_FULLSCREEN_MESSAGE,
  isFocusViewConfigured,
} from '../../utils/focusView.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const arg = args.trim().toLowerCase()
  if (arg && arg !== 'on' && arg !== 'off') {
    onDone(`Unknown argument "${arg}". Use: /focus [on|off]`, { display: 'system' })
    return null
  }
  const current = context.getAppState().briefTranscript
  const enable = arg ? arg === 'on' : !current

  if (enable && !isFullscreenEnvEnabled()) {
    onDone(FOCUS_NEEDS_FULLSCREEN_MESSAGE, { display: 'system' })
    return null
  }

  saveGlobalConfig(config =>
    config.briefTranscript === enable ? config : { ...config, briefTranscript: enable },
  )
  context.setAppState(prev =>
    prev.briefTranscript === enable ? prev : { ...prev, briefTranscript: enable },
  )

  const viewMode = getInitialSettings().viewMode
  if (viewMode && isFocusViewConfigured() !== enable) {
    onDone(
      `${enable ? 'Focus view enabled' : 'Focus view disabled'} for this session. "viewMode": "${viewMode}" in settings.json sets the view on the next start.`,
      { display: 'system' },
    )
    return null
  }
  onDone(enable ? 'Focus view enabled' : 'Focus view disabled', { display: 'system' })
  return null
}
