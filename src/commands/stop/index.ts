import type { Command } from '../../commands.js'
import { isBgSession } from '../../utils/concurrentSessions.js'

const stop: Command = {
  type: 'local-jsx',
  name: 'stop',
  description: 'Stop this background session; transcript and worktree are kept',
  immediate: true,
  isEnabled: () => isBgSession(),
  load: () => import('./stop.js'),
}

export default stop
