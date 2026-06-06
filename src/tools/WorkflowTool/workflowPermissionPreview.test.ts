#!/usr/bin/env node
import assert from 'node:assert/strict'

import { formatWorkflowPermissionPreview } from './workflowPermissionPreview.js'

const preview = formatWorkflowPermissionPreview({
  workflowName: 'deep-research-demo',
  description: 'Research a question with scoped search and synthesis agents',
  args: 'tmux loading check',
  cwd: '/repo',
  phases: [
    {
      title: 'Scope',
      detail: 'Clarify the question and choose research angles',
      prompts: ['Break this research question into 3 focused investigation angles.'],
    },
    {
      title: 'Investigate',
      detail: 'Run focused research agents in parallel',
      prompts: ['angle.prompt'],
    },
  ],
})

assert.match(preview, /Run a dynamic workflow\?/)
assert.match(preview, /Research a question with scoped search and synthesis agents/)
assert.match(preview, /This dynamic workflow will spin up multiple subagents/)
assert.match(preview, /1\. Scope — Clarify the question and choose research angles/)
assert.match(preview, /· "Break this research question into 3 focused investigation angles\."/)
assert.match(preview, /2\. Investigate — Run focused research agents in parallel/)
assert.match(preview, /args: "tmux loading check"/)
assert.match(preview, /Dynamic workflows can use a lot of tokens quickly/)
assert.match(preview, /1\. Yes, run it/)
assert.match(preview, /2\. Yes, and don't ask again for deep-research-demo in \/repo/)
assert.match(preview, /3\. View raw script/)
assert.match(preview, /4\. No/)
assert.match(preview, /Esc to cancel · Tab to amend/)
assert.match(preview, /ctrl\+g to edit script in \$EDITOR/)

console.log('workflowPermissionPreview.test.ts passed')
