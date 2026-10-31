import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

const config = {
  aliases: ['settings'],
  type: 'local-jsx',
  name: 'config',
  description: 'Open settings',
  argumentHint: '[key=value]',
  immediate: () => isFullscreenEnvEnabled(),
  load: () => import('./config.js'),
} satisfies Command

export default config

export const configNonInteractive = {
  type: 'local',
  name: 'config',
  supportsNonInteractive: true,
  aliases: ['settings'],
  description: 'Set a setting by key',
  argumentHint: 'key=value',
  isEnabled: getIsNonInteractiveSession,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./configNonInteractive.js'),
} satisfies Command
