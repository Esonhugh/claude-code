import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'

// Official 2.1.329 /fork with agent view on: the parent keeps the terminal.
const fork: Command = {
  type: 'local-jsx',
  name: 'fork',
  description: 'Copy this conversation into a new background session and keep working here',
  argumentHint: '[prompt]',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./fork.js'),
}

export default fork
