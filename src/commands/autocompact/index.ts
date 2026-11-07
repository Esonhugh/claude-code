import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export const autocompact: Command = {
  type: 'local-jsx',
  name: 'autocompact',
  aliases: ['context-window'],
  description: 'Set the context window: how full the context gets before auto-summarizing',
  immediate: true,
  isEnabled: () => !getIsNonInteractiveSession(),
  argumentHint: '[auto|<tokens>]',
  load: () => import('./autocompact.js'),
}

export const autocompactNonInteractive: Command = {
  type: 'local',
  name: 'autocompact',
  aliases: ['context-window'],
  supportsNonInteractive: true,
  description: 'Configure the auto-compact window size',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  argumentHint: '[auto|<tokens>]',
  load: () => import('./autocompact-noninteractive.js'),
}
