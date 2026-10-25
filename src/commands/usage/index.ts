import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  aliases: ['cost'],
  description: 'Show session cost and plan usage',
  immediate: true,
  load: () => import('./usage.js'),
} satisfies Command
