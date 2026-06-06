import type { Command } from '../../commands.js'
import { isAnt } from 'src/utils/userType.js'


const files = {
  type: 'local',
  name: 'files',
  description: 'List all files currently in context',
  isEnabled: () => isAnt(),
  supportsNonInteractive: true,
  load: () => import('./files.js'),
} satisfies Command

export default files
