import type { Command } from '../../commands.js'

const outputStyle = {
  type: 'local',
  name: 'output-style',
  supportsNonInteractive: true,
  description: 'List output styles or switch to one',
  argumentHint: '[style]',
  load: () => import('./output-style.js'),
} satisfies Command

export default outputStyle
