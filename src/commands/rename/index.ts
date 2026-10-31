import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

const rename = {
  type: 'local-jsx',
  name: 'rename',
  aliases: ['name'],
  description: 'Rename the current conversation',
  immediate: true,
  argumentHint: '[name]',
  load: () => import('./rename.js'),
} satisfies Command

export default rename

export const renameNonInteractive = {
  type: 'local',
  name: 'rename',
  supportsNonInteractive: true,
  aliases: ['name'],
  description: 'Rename the current conversation',
  argumentHint: '[name]',
  isEnabled: getIsNonInteractiveSession,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./renameNonInteractive.js'),
} satisfies Command
