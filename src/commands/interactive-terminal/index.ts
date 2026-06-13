import type { Command } from '../../commands.js'

const interactiveTerminal = {
  type: 'local-jsx',
  name: 'interactive-terminal',
  description: 'View interactive terminal sessions',
  immediate: true,
  load: () => import('./interactive-terminal.js'),
} satisfies Command

export default interactiveTerminal
