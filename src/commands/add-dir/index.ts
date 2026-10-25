import type { Command } from '../../commands.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

const addDir = {
  type: 'local-jsx',
  name: 'add-dir',
  description: 'Add a new working directory',
  argumentHint: '<path>',
  immediate: args => args.trim() !== '' || isFullscreenEnvEnabled(),
  load: () => import('./add-dir.js'),
} satisfies Command

export default addDir
