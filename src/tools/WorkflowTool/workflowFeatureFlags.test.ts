import assert from 'node:assert/strict'
import { isWorkflowScriptsFeatureEnabled } from './workflowFeatureFlags.js'

const previous = process.env.CLAUDE_CODE_RECOVER_FEATURES

try {
  delete process.env.CLAUDE_CODE_RECOVER_FEATURES
  assert.equal(isWorkflowScriptsFeatureEnabled(), false)

  process.env.CLAUDE_CODE_RECOVER_FEATURES = 'OTHER,WORKFLOW_SCRIPTS'
  assert.equal(isWorkflowScriptsFeatureEnabled(), true)

  process.env.CLAUDE_CODE_RECOVER_FEATURES = 'WORKFLOW_SCRIPT'
  assert.equal(isWorkflowScriptsFeatureEnabled(), false)
} finally {
  if (previous === undefined) delete process.env.CLAUDE_CODE_RECOVER_FEATURES
  else process.env.CLAUDE_CODE_RECOVER_FEATURES = previous
}

console.log('workflowFeatureFlags.test.ts passed')
