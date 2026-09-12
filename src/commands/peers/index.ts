import type { Command } from '../../commands.js'
import { getUdsMessagingSocketPath } from '../../utils/udsMessaging.js'

const listAgents = {
  type: 'local-jsx',
  name: 'list-agents',
  aliases: ['peers'],
  description: 'List other live local Claude sessions',
  isEnabled: () => getUdsMessagingSocketPath() !== null,
  load: async () => ({
    async call(onDone) {
      const [{ createElement }, { AgentListDialog }, { listAllLiveSessions }] =
        await Promise.all([
          import('react'),
          import('../../tools/ListAgentsTool/UI.js'),
          import('../../utils/udsClient.js'),
        ])
      return createElement(AgentListDialog, {
        agents: await listAllLiveSessions(),
        onDone: () => onDone(undefined, { display: 'skip' }),
      })
    },
  }),
} satisfies Command

export default listAgents
