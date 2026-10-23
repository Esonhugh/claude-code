import type { Command } from '../../commands.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

const theme = {
  type: 'local-jsx',
  name: 'theme',
  description: 'Change the theme',
  immediate: () => isFullscreenEnvEnabled(),
  load: () => import('./theme.js'),
} satisfies Command

export default theme
