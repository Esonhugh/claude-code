import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeEnabled,
} from '../../utils/fastMode.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getAPIProvider } from '../../utils/model/providers.js'

const fast = {
  type: 'local-jsx',
  name: 'fast',
  get description() {
    return getAPIProvider() === 'openai'
      ? 'Toggle fast mode'
      : `Toggle fast mode (${FAST_MODE_MODEL_DISPLAY})`
  },
  isEnabled: () => isFastModeEnabled(),
  get isHidden() {
    return !isFastModeEnabled()
  },
  argumentHint: '[on|off]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./fast.js'),
} satisfies Command

export default fast

export const fastNonInteractive = {
  type: 'local',
  name: 'fast',
  supportsNonInteractive: true,
  get description() {
    return fast.description
  },
  argumentHint: '[on|off]',
  isEnabled: () => getIsNonInteractiveSession() && isFastModeEnabled(),
  get isHidden() {
    return !getIsNonInteractiveSession() || !isFastModeEnabled()
  },
  load: () => import('./fastNonInteractive.js'),
} satisfies Command
