import type { Command } from '../../commands.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: 'Show help and available commands',
  immediate: () => isFullscreenEnvEnabled(),
  load: () => import('./help.js'),
} satisfies Command

export default help
