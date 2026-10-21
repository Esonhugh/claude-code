import type { Command } from '../../commands.js'

const recap = {
  type: 'local',
  name: 'recap',
  description: 'Generate a one-line session recap now',
  supportsNonInteractive: true,
  load: () => import('./recap.js'),
} satisfies Command

export default recap
