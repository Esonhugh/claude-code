/**
 * Cost command - minimal metadata only.
 * Implementation is lazy-loaded from cost.ts to reduce startup time.
 * Non-interactive /usage (aliases /cost, /stats); interactive sessions use the
 * /usage dialog instead.
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

const cost = {
  type: 'local',
  name: 'usage',
  aliases: ['cost', 'stats'],
  description: 'Show session cost and plan usage',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled: () => getIsNonInteractiveSession(),
  supportsNonInteractive: true,
  load: () => import('./cost.js'),
} satisfies Command

export default cost
