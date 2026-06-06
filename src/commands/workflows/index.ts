import type { Command } from '../../commands.js'

const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  description: 'View dynamic workflow runs',
  argumentHint: '[list|show|dry-run|run|templates|save-template|run-template|status|pause|resume] [name-or-path]',
  immediate: true,
  load: () => import('./workflowsPage.js'),
} satisfies Command

export default workflows
