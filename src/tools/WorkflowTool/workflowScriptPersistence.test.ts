import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { workflowSessionDir } from './workflowRunSessions.js'
import {
  createWorkflowRunId,
  persistWorkflowScript,
  resolveWorkflowScriptPath,
} from './workflowScriptPersistence.js'

const workflowRunIdFormat = createWorkflowRunId()
assert.match(workflowRunIdFormat, /^wf_[a-z0-9-]{6,}$/)
assert.equal(workflowRunIdFormat.slice(3).includes('_'), false)

const cwd = await realpath(await mkdtemp(join(tmpdir(), 'workflow-script-persistence-')))
process.env.CLAUDE_CONFIG_DIR = join(cwd, 'config')
const workflowRunId = 'wf_test_123'
const script = 'export default workflow({ name: "research", description: "Research", phases: [] })'
const scriptPath = await persistWorkflowScript({
  cwd,
  workflowRunId,
  name: 'research',
  script,
})

// Like official 2.1.303: <session>/workflows/scripts/<sanitized name>-<runId>.js, never under cwd.
assert.equal(scriptPath, join(workflowSessionDir(cwd), 'workflows', 'scripts', 'research-wf_test_123.js'))
assert.equal(await readFile(scriptPath, 'utf8'), script)
assert.equal(await resolveWorkflowScriptPath({ cwd, scriptPath }), scriptPath)
assert.match(
  await persistWorkflowScript({ cwd, workflowRunId: 'wf_spaced', name: ' My Workflow! ', script }),
  /\/my-workflow-wf_spaced\.js$/,
)
assert.match(
  await persistWorkflowScript({ cwd, workflowRunId: 'wf_empty', name: '!!!', script }),
  /\/workflow-wf_empty\.js$/,
)

console.log('workflowScriptPersistence.test.ts passed')
