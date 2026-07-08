import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createWorkflowRunId,
  persistWorkflowScript,
  resolveWorkflowScriptPath,
} from './workflowScriptPersistence.js'

const workflowRunIdFormat = createWorkflowRunId()
assert.match(workflowRunIdFormat, /^wf_[a-z0-9-]{6,}$/)
assert.equal(workflowRunIdFormat.slice(3).includes('_'), false)

const cwd = await mkdtemp(join(tmpdir(), 'workflow-script-persistence-'))
const workflowRunId = 'wf_test_123'
const script = 'export default workflow({ name: "research", description: "Research", phases: [] })'
const scriptPath = await persistWorkflowScript({
  cwd,
  workflowRunId,
  name: 'research',
  script,
})

assert.match(scriptPath, /\.claude\/workflow-runs\/wf_test_123\/research\.js$/)
assert.equal(await readFile(scriptPath, 'utf8'), script)
assert.equal(await resolveWorkflowScriptPath({ cwd, scriptPath }), scriptPath)

console.log('workflowScriptPersistence.test.ts passed')
