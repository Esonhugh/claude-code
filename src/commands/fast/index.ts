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
      : `Toggle fast mode (${FAST_MODE_MODEL_DISPLAY} only)`
  },
  availability: ['claude-ai', 'console', 'chatgpt'],
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
