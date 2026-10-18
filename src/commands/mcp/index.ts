import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Manage MCP servers',
  immediate: true,
  argumentHint: '[reconnect (<server>|all)|enable|disable [<server>|all]]',
  load: () => import('./mcp.js'),
} satisfies Command

export const mcpNonInteractive = {
  type: 'local',
  name: 'mcp',
  supportsNonInteractive: true,
  description: 'Manage MCP servers',
  argumentHint: '[reconnect|enable|disable [<server>|all]]',
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  load: () => import('./mcp-noninteractive.js'),
} satisfies Command

export default mcp
