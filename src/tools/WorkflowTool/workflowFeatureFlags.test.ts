#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  isWorkflowKeywordTriggerEnabled,
  isWorkflowScriptsFeatureEnabled,
  shouldEnableWorkflows,
  shouldShowWorkflowUsageWarning,
} from './workflowFeatureFlags.js'

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

assert.equal(shouldEnableWorkflows({ enableWorkflows: true }), true)
assert.equal(shouldEnableWorkflows({ disableWorkflows: true }), false)
assert.equal(
  shouldEnableWorkflows({ enableWorkflows: true, disableWorkflows: true }),
  false,
)
assert.equal(isWorkflowKeywordTriggerEnabled({ workflowKeywordTriggerEnabled: false }), false)
assert.equal(isWorkflowKeywordTriggerEnabled({ workflowKeywordTriggerEnabled: true }), true)
assert.equal(isWorkflowKeywordTriggerEnabled({ ultracodeKeywordTrigger: false }), false)
assert.equal(shouldShowWorkflowUsageWarning({ skipWorkflowUsageWarning: true }), false)
assert.equal(shouldShowWorkflowUsageWarning({ skipWorkflowUsageWarning: false }), true)

console.log('workflowFeatureFlags.test.ts passed')
