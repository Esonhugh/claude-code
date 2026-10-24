import type { Command } from '../../commands.js'
import { isSqliteMemoryEnabled } from '../../memdir/paths.js'

const setupMemoryDb = {
  type: 'local',
  name: 'setup-memory-db',
  description: 'Build the SQLite memory search index',
  isEnabled: () => isSqliteMemoryEnabled(),
  supportsNonInteractive: true,
  load: () => import('./setupMemoryDb.js'),
} satisfies Command

export default setupMemoryDb
