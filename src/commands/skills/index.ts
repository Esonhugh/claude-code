import type { Command } from '../../commands.js'

const skills = {
  type: 'local-jsx',
  name: 'skills',
  description: 'List available skills',
  immediate: true,
  load: () => import('./skills.js'),
} satisfies Command

export default skills
