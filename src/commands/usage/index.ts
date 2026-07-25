import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show plan usage limits',
  availability: ['chatgpt', 'claude-ai'],
  immediate: true,
  load: () => import('./usage.js'),
} satisfies Command
