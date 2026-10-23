import type { Command } from '../../commands.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

const config = {
  aliases: ['settings'],
  type: 'local-jsx',
  name: 'config',
  description: 'Open config panel',
  immediate: () => isFullscreenEnvEnabled(),
  load: () => import('./config.js'),
} satisfies Command

export default config
