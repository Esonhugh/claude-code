/**
 * Color command - minimal metadata only.
 * Implementation is lazy-loaded from color.ts to reduce startup time.
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { AGENT_COLORS } from '../../tools/AgentTool/agentColorManager.js'

const COLOR_HINT = `[${[...AGENT_COLORS, 'default'].join('|')}]`

const color = {
  type: 'local-jsx',
  name: 'color',
  description: 'Set the prompt bar color for this session',
  immediate: true,
  terminalOriented: true,
  argumentHint: COLOR_HINT,
  load: () => import('./color.js'),
} satisfies Command

export default color

export const colorNonInteractive = {
  type: 'local',
  name: 'color',
  supportsNonInteractive: true,
  description: 'Set the prompt bar color for this session',
  terminalOriented: true,
  argumentHint: COLOR_HINT,
  isEnabled: getIsNonInteractiveSession,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./colorNonInteractive.js'),
} satisfies Command
