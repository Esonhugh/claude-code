import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

// Like official 2.1.329: a coordinator session has no subtasks, so the command is hidden there.
function isCoordinatorSession(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isCoordinatorMode } = require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js')
  return isCoordinatorMode()
}

export default {
  type: 'local-jsx',
  name: 'subtask',
  description: 'Send a subagent off with your full context; its result comes back here',
  argumentHint: '<task>',
  isEnabled: () => !getIsNonInteractiveSession() && !isCoordinatorSession(),
  load: () => import('./subtask.js'),
} satisfies Command
