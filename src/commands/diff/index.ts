import type { Command } from '../../commands.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

export const MIN_DIFF_SIDEBAR_COLUMNS = 110

export default {
  type: 'local-jsx',
  name: 'diff',
  description: 'View uncommitted changes and per-turn diffs',
  immediate: () => isFullscreenEnvEnabled(),
  load: () => import('./diff.js'),
} satisfies Command
