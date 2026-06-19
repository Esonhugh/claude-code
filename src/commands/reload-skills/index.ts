import type { Command } from '../../commands.js'

const reloadSkills = {
  type: 'local',
  name: 'reload-skills',
  description: 'Reload skills from disk without refreshing plugins',
  supportsNonInteractive: false,
  load: () => import('./reload-skills.js'),
} satisfies Command

export default reloadSkills
