/**
 * /reload-plugins — Layer-3 refresh. Applies pending plugin changes to the
 * running session. Implementation lazy-loaded.
 */
import type { Command } from '../../commands.js'

const reloadPlugins = {
  type: 'local',
  name: 'reload-plugins',
  description: 'Activate pending plugin changes in the current session',
  terminalOriented: true,
  supportsNonInteractive: true,
  load: () => import('./reload-plugins.js'),
} satisfies Command

export default reloadPlugins
