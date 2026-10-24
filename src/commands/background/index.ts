import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { isBgSession } from '../../utils/concurrentSessions.js'

const background: Command = {
  type: 'local-jsx',
  name: 'background',
  aliases: ['bg'],
  description: 'Send this session to the background and free the terminal',
  argumentHint: '[prompt]',
  isEnabled: () => !getIsNonInteractiveSession() && !isBgSession(),
  load: () => import('./background.js'),
}

export default background
