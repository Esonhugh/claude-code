import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getAPIProvider } from '../../utils/model/providers.js'

export default {
  type: 'local-jsx',
  name: 'daybreak',
  description: 'Set the OpenAI Daybreak access program',
  argumentHint: '[blue|red]',
  isEnabled: () => getAPIProvider() === 'openai',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./daybreak.js'),
} satisfies Command
