import type { Command } from '../../commands.js'
import { isAnt } from 'src/utils/userType.js'


const tag = {
  type: 'local-jsx',
  name: 'tag',
  description: 'Toggle a searchable tag on the current session',
  isEnabled: () => isAnt(),
  argumentHint: '<tag-name>',
  load: () => import('./tag.js'),
} satisfies Command

export default tag
