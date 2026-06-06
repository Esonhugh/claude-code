import assert from 'node:assert/strict'

import {
  mapWorkflowPermissionSelectionToResult,
  workflowInputWithEditedScript,
  workflowPermissionInitialInput,
  workflowPermissionPreviewFromToolInput,
} from './WorkflowPermissionRequestModel.js'

const input = {
  action: 'run',
  selector: 'deep-research',
  runArgs: 'topic: workflows',
  plan: {
    name: 'deep-research',
    description: 'Deep research workflow.',
    phases: [
      {
        id: 'scope',
        description: 'Scope the question.',
        prompt: 'Scope prompt',
      },
      {
        id: 'search',
        description: 'Search from angles.',
        prompt: 'Search prompt',
        fanout: 3,
      },
    ],
    runScriptSnapshot: 'export const meta = { name: \'deep-research\' }',
  },
}

assert.deepEqual(mapWorkflowPermissionSelectionToResult('yes', input, '/repo'), {
  behavior: 'allow',
  updatedInput: input,
  permissionUpdates: [],
})

assert.deepEqual(mapWorkflowPermissionSelectionToResult('yes-always', input, '/repo'), {
  behavior: 'allow',
  updatedInput: input,
  permissionUpdates: [
    {
      type: 'addRules',
      rules: [
        {
          toolName: 'WorkflowTool',
          ruleContent: 'deep-research:/repo',
        },
      ],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ],
})

assert.deepEqual(mapWorkflowPermissionSelectionToResult('no', input, '/repo'), {
  behavior: 'reject',
})

assert.deepEqual(mapWorkflowPermissionSelectionToResult('view-raw', input, '/repo'), {
  behavior: 'view-raw',
  script: 'export const meta = { name: \'deep-research\' }',
})

const editedInput = workflowInputWithEditedScript(
  input,
  'export const meta = { name: \'edited\' }',
)
assert.equal(editedInput.script, 'export const meta = { name: \'edited\' }')
assert.equal(
  editedInput.plan?.runScriptSnapshot,
  'export const meta = { name: \'edited\' }',
)
assert.equal(editedInput.plan?.name, 'deep-research')

assert.equal(
  workflowPermissionInitialInput(
    { action: 'run', selector: 'deep-research' },
    input,
  ),
  input,
)

const preview = workflowPermissionPreviewFromToolInput(input, '/repo')
assert.match(preview, /Run a dynamic workflow\?/)
assert.match(preview, /Deep research workflow\./)
assert.match(preview, /1\. Scope/)
assert.match(preview, /2\. Search/)
assert.match(preview, /args: "topic: workflows"/)
assert.match(preview, /3\. View raw script/)

const nameOnlyPreview = workflowPermissionPreviewFromToolInput(
  { name: 'compatibility-smoke', args: 'running smoke' },
  '/repo',
)
assert.match(nameOnlyPreview, /don't ask again for compatibility-smoke in \/repo/)

console.log('WorkflowPermissionRequest.test.ts passed')
