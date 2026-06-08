import type { Command } from '../../commands.js'

const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  description: 'View dynamic workflow runs',
  argumentHint: '',
  immediate: true,
  load: () => import('./workflowsPage.js'),
} satisfies Command

export default workflows
