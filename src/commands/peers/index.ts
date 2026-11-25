import type { Command } from '../../commands.js'
import { getUdsMessagingSocketPath } from '../../utils/udsMessaging.js'

const listAgents = {
  type: 'local',
  name: 'list-agents',
  aliases: ['peers'],
  description: 'List subagents, teammates, and other Claude sessions you can message',
  supportsNonInteractive: true,
  isEnabled: () => getUdsMessagingSocketPath() !== null,
  load: async () => ({
    async call(_args, context) {
      const [tool, { listAllLiveSessions }] = await Promise.all([
        import('../../tools/ListAgentsTool/ListAgentsTool.js'),
        import('../../utils/udsClient.js'),
      ])
      const state = context.getAppState()
      return {
        type: 'text' as const,
        value: tool.formatAgentCommandListing(tool.selfAddress(), tool.listSubagents(state), tool.listTeammates(state), await listAllLiveSessions()),
      }
    },
  }),
} satisfies Command

export default listAgents
