import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

const EFFORT_HINT = 'none|minimal|low|medium|high|xhigh|max|ultra|ultracode|auto'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  argumentHint: `[${EFFORT_HINT}]`,
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command

export const effortNonInteractive = {
  type: 'local',
  name: 'effort',
  supportsNonInteractive: true,
  description: 'Set effort level for model usage',
  argumentHint: `<${EFFORT_HINT}>`,
  isEnabled: getIsNonInteractiveSession,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./effortNonInteractive.js'),
} satisfies Command
