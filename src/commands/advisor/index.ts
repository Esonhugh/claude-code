import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isAdvisorEnabled } from '../../utils/advisor.js'

const DESCRIPTION = 'Let Claude consult a stronger model at key moments'

export default {
  type: 'local-jsx',
  name: 'advisor',
  description: DESCRIPTION,
  argumentHint: '[model|off]',
  isEnabled: isAdvisorEnabled,
  get isHidden() {
    return !isAdvisorEnabled()
  },
  load: () => import('./advisor.js'),
} satisfies Command

export const advisorNonInteractive = {
  type: 'local',
  name: 'advisor',
  supportsNonInteractive: true,
  description: DESCRIPTION,
  argumentHint: '<model|off>',
  isEnabled: () => getIsNonInteractiveSession() && isAdvisorEnabled(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./advisorNonInteractive.js'),
} satisfies Command
