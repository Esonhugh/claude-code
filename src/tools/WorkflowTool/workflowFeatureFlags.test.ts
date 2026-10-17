#!/usr/bin/env node
import assert from 'node:assert/strict'
import {
  isWorkflowKeywordTriggerEnabled,
  isWorkflowScriptsFeatureEnabled,
  shouldEnableWorkflows,
  workflowsDefaultOn,
  workflowSizeGuidelinePrompt,
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

// Like official 2.1.292: on by default except on the Pro plan; disableWorkflows,
// CLAUDE_CODE_DISABLE_WORKFLOWS, CLAUDE_CODE_WORKFLOWS=0 or enableWorkflows: false turn it off.
assert.equal(shouldEnableWorkflows(undefined, null), true)
assert.equal(shouldEnableWorkflows({}, 'max'), true)
assert.equal(shouldEnableWorkflows({}, 'pro'), false)
assert.equal(shouldEnableWorkflows({ enableWorkflows: true }, 'pro'), true)
assert.equal(shouldEnableWorkflows({ enableWorkflows: false }, null), false)
assert.equal(shouldEnableWorkflows({ disableWorkflows: true }, null), false)
assert.equal(shouldEnableWorkflows({ enableWorkflows: true, disableWorkflows: true }, null), false)
for (const [name, value] of [['CLAUDE_CODE_DISABLE_WORKFLOWS', '1'], ['CLAUDE_CODE_WORKFLOWS', '0']] as const) {
  const saved = process.env[name]
  process.env[name] = value
  try {
    assert.equal(shouldEnableWorkflows({ enableWorkflows: true }, null), false)
  } finally {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  }
}

// Like official, the tool prompt carries an advisory workflow size guideline: medium by
// default (small on Pro), set in /config or overridden by settings, absent when unrestricted.
const guideline = 'This is a guideline, not a hard limit — follow it unless the user\'s prompt calls for a different scale.'
assert.equal(
  workflowSizeGuidelinePrompt({}, undefined, null),
  `\n\nThis session has the default workflow size guideline: medium — keep workflows under 10 agents. ${guideline} The user can raise or remove it with "Dynamic workflow size" in /config.`,
)
assert.match(workflowSizeGuidelinePrompt({}, undefined, 'pro'), /default workflow size guideline: small — keep workflows under 5 agents\./)
assert.equal(
  workflowSizeGuidelinePrompt({}, 'large', null),
  `\n\nA workflow size guideline is configured for this session: large — keep workflows under 50 agents. ${guideline}`,
)
assert.match(workflowSizeGuidelinePrompt({ workflowSizeGuideline: 'small' }, 'large', null), /configured for this session: small/)
assert.equal(workflowSizeGuidelinePrompt({}, 'unrestricted', null), '')
assert.equal(isWorkflowKeywordTriggerEnabled({ workflowKeywordTriggerEnabled: false }), false)
assert.equal(isWorkflowKeywordTriggerEnabled({ workflowKeywordTriggerEnabled: true }), true)
assert.equal(isWorkflowKeywordTriggerEnabled({ ultracodeKeywordTrigger: false }), false)

// Like official, CLAUDE_CODE_WORKFLOWS=1 makes workflows default on (even on Pro) unless
// disableWorkflows or enableWorkflows: false turns them off.
{
  const saved = process.env.CLAUDE_CODE_WORKFLOWS
  process.env.CLAUDE_CODE_WORKFLOWS = '1'
  try {
    assert.equal(workflowsDefaultOn('pro'), true)
    assert.equal(shouldEnableWorkflows({}, 'pro'), true)
    assert.equal(shouldEnableWorkflows({ enableWorkflows: false }, 'pro'), false)
    assert.equal(shouldEnableWorkflows({ disableWorkflows: true }, 'pro'), false)
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_WORKFLOWS
    else process.env.CLAUDE_CODE_WORKFLOWS = saved
  }
}

console.log('workflowFeatureFlags.test.ts passed')
