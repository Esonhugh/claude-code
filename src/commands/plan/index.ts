import type { Command } from '../../commands.js'
import { isPlanModeAvailable } from '../../utils/planModeV2.js'

const plan = {
  type: 'local-jsx',
  name: 'plan',
  isEnabled: isPlanModeAvailable,
  description: 'Enable plan mode or view the current session plan',
  argumentHint: '[open|<description>]',
  load: () => import('./plan.js'),
} satisfies Command

export default plan
