#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { workflowPermissionPreviewInput } from './workflowPermissionPreviewInput.js'
import type { WorkflowPermissionToolInput } from './WorkflowPermissionRequestModel.js'

const tempRoot = await mkdtemp(join(tmpdir(), 'workflow-permission-preview-input-'))
await mkdir(join(tempRoot, '.claude', 'workflows'), { recursive: true })
const source = `export const meta = {
  name: 'compatibility-smoke',
  description: 'Compatibility smoke workflow for permission comparison.',
  phases: [
    { title: 'Scope', detail: 'Read args and prepare one check' },
    { title: 'Check', detail: 'Run one agent and report observable output' }
  ]
}

export default workflow({
  name: 'compatibility-smoke',
  description: 'Compatibility smoke workflow for permission comparison.',
  defaults: { maxConcurrency: 1, maxAgents: 1, permissionMode: 'plan' },
  phases: [agent({
    id: 'check',
    description: 'Run smoke check.',
    prompt: ({ args }) => 'Return exactly: workflow smoke ' + JSON.stringify(args)
  })]
})
`
await writeFile(join(tempRoot, '.claude', 'workflows', 'compatibility-smoke.js'), source)

const input: WorkflowPermissionToolInput = {
  action: 'run',
  selector: 'compatibility-smoke',
  runArgs: 'permission smoke',
}
const preview = await workflowPermissionPreviewInput(input, tempRoot)

assert.equal(preview.selector, 'compatibility-smoke')
assert.equal(preview.runArgs, 'permission smoke')
assert.equal(preview.script, source)
assert.deepEqual(preview.plan, {
  name: 'compatibility-smoke',
  description: 'Compatibility smoke workflow for permission comparison.',
  phases: [
    {
      title: 'Scope',
      detail: 'Read args and prepare one check',
      prompt: `{
    id: 'check',
    description: 'Run smoke check.',`,
    },
    { title: 'Check', detail: 'Run one agent and report observable output' },
  ],
  runScriptSnapshot: source,
})

console.log('workflowPermissionPreviewInput.test.ts passed')
