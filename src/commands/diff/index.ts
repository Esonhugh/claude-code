import type { Command } from '../../commands.js'

export const MIN_DIFF_SIDEBAR_COLUMNS = 110

export default {
  type: 'local-jsx',
  name: 'diff',
  description: 'View uncommitted changes and per-turn diffs',
  immediate: (_args, context) =>
    (context.modCommand?.presentation.columns ?? 0) >= MIN_DIFF_SIDEBAR_COLUMNS,
  load: () => import('./diff.js'),
} satisfies Command
