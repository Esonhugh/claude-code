import type { Command } from '../../commands.js'

const agents = {
  type: 'local',
  name: 'agents',
  description:
    '(removed) Ask Claude to create/manage subagents, or edit .claude/agents/',
  isHidden: true,
  supportsNonInteractive: true,
  load: () => import('./agents.js'),
} satisfies Command

export default agents
