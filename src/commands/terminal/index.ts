import type { Command } from '../../commands.js'

const terminal = {
  type: 'local-jsx',
  name: 'terminal',
  description: 'View terminal sessions',
  immediate: true,
  load: () => import('./terminal.js'),
} satisfies Command

export default terminal
