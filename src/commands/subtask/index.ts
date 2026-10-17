import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'subtask',
  description: 'Send a subagent off with your full context; its result comes back here',
  argumentHint: '<task>',
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./subtask.js'),
} satisfies Command
