import type { Command } from '../../commands.js'

const workflows = {
  type: 'local',
  name: 'workflows',
  description: 'List, show, dry-run, run, template, and control workflow specs',
  argumentHint: '[list|show|dry-run|run|templates|save-template|run-template|status|pause|resume] [name-or-path]',
  supportsNonInteractive: true,
  load: () => import('./workflows.js'),
} satisfies Command

export default workflows
