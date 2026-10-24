import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

const focus: Command = {
  type: 'local-jsx',
  name: 'focus',
  description: 'Toggle focus view: just your prompt, summary, and response',
  argumentHint: '[on|off]',
  immediate: true,
  isEnabled: () => !getIsNonInteractiveSession(),
  load: () => import('./focus.js'),
}

export default focus
