import type { Command } from '../../commands.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'

const daemon: Command = {
  type: 'local-jsx',
  name: 'daemon',
  description: 'Manage background services and sessions',
  immediate: true,
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./daemon.js'),
}

export default daemon
